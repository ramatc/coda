import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { AppModule } from "../src/app.module.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed
// (matches auth-guard.e2e / social.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

const VIEWER_CLERK = "user_viewer";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN_REVIEW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/**
 * The narrow Prisma surface `GET /reviews/:id` touches, stubbed so the route can
 * be exercised end to end without a live Postgres (the project's no-docker
 * sandbox convention). One review, authored by someone else, liked by the
 * viewer — enough to tell the anonymous and signed-in viewer blocks apart.
 */
function stubPrisma(): PrismaService {
  const client = {
    user: {
      async findUnique(args: { where: { clerkUserId: string } }) {
        return args.where.clerkUserId === VIEWER_CLERK
          ? { id: VIEWER_ID }
          : null;
      },
    },
    review: {
      async findUnique(args: { where: { id: string } }) {
        if (args.where.id !== REVIEW_ID) return null;
        return {
          id: REVIEW_ID,
          body: "A masterpiece, front to back.",
          isSpoiler: false,
          createdAt: new Date("2026-07-25T10:00:00.000Z"),
          updatedAt: new Date("2026-07-25T11:00:00.000Z"),
          album: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "OK Computer",
            coverUrl: null,
            primaryArtist: { name: "Radiohead" },
          },
          user: {
            profile: {
              username: "author",
              displayName: "The Author",
              avatarUrl: null,
            },
          },
          _count: { likes: 1, comments: 0 },
          comments: [],
        };
      },
    },
    reviewLike: {
      async findUnique(args: {
        where: { userId_reviewId: { userId: string; reviewId: string } };
      }) {
        const { userId, reviewId } = args.where.userId_reviewId;
        return userId === VIEWER_ID && reviewId === REVIEW_ID
          ? { userId }
          : null;
      },
    },
  };
  return { client } as unknown as PrismaService;
}

/**
 * HTTP-layer proof for the app's ONLY anonymous-readable route. The controller
 * spec asserts decorator placement but never exercises Nest's guard pipeline,
 * so it cannot prove that the global fail-closed `ClerkGuard` and the
 * route-scoped `OptionalClerkGuard` actually compose the way the design claims.
 * That composition is the whole point of this slice: anonymous callers must get
 * 200 (not 401), and signed-in callers must get a REAL viewer block (not the
 * anonymous one) even though the route is `@Public()`.
 */
describe("Reviews API (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(stubPrisma())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
  });

  it("serves GET /reviews/:id to an anonymous caller (200, never 401)", async () => {
    const res = await request(app.getHttpServer()).get(`/reviews/${REVIEW_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.body).toBe("A masterpiece, front to back.");
    expect(res.body.likeCount).toBe(1);
    expect(res.body.viewer).toEqual({ hasLiked: false, canInteract: false });
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("resolves a signed-in caller on the same @Public() route (canInteract true)", async () => {
    mockedVerifyToken.mockResolvedValue({
      sub: VIEWER_CLERK,
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);

    const res = await request(app.getHttpServer())
      .get(`/reviews/${REVIEW_ID}`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    // Without `OptionalClerkGuard` the global guard would have short-circuited
    // on @Public() and left `@CurrentUser("sub")` undefined here, serving a
    // signed-in user the anonymous block and dead like/comment CTAs.
    expect(res.body.viewer).toEqual({ hasLiked: true, canInteract: true });
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("degrades an expired or tampered token to anonymous (200, not 401)", async () => {
    mockedVerifyToken.mockRejectedValue(new Error("token expired"));

    const res = await request(app.getHttpServer())
      .get(`/reviews/${REVIEW_ID}`)
      .set("Authorization", "Bearer expired.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body.viewer).toEqual({ hasLiked: false, canInteract: false });
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("answers an unknown review id with 404 (not 500) for an anonymous caller", async () => {
    const res = await request(app.getHttpServer()).get(
      `/reviews/${UNKNOWN_REVIEW_ID}`,
    );

    expect(res.status).toBe(404);
  });
});
