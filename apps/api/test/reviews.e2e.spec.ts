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
import { Prisma } from "@coda/db";
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
const COMMENT_ID = "10000000-0000-4000-8000-000000000001";

/** Builds a P2002 in this project's real driver-adapter shape (Decision #14). */
function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`user_id`,`review_id`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["user_id"] },
          },
        },
      },
    },
  );
}

/** Builds a P2003 foreign-key violation in this project's real shape. */
function foreignKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint failed on the field: `review_id`",
    { code: "P2003", clientVersion: "test" },
  );
}

/**
 * The narrow Prisma surface the `/reviews` routes touch, stubbed so they can be
 * exercised end to end without a live Postgres (the project's no-docker sandbox
 * convention). One review, authored by someone else, liked by the viewer —
 * enough to tell the anonymous and signed-in viewer blocks apart.
 *
 * The like store is MUTABLE and `reset()` restores it between tests, because the
 * duplicate-like scenario needs two sequential HTTP requests to share state:
 * proving the second one is a 409 is only meaningful if the first one really
 * persisted. `create` enforces the composite PK the way Postgres would (P2002),
 * and rejects an unknown review with the FK error (P2003).
 */
function stubPrisma() {
  let likes: { userId: string; reviewId: string }[] = [];

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
      async create(args: { data: { userId: string; reviewId: string } }) {
        const { userId, reviewId } = args.data;
        if (reviewId !== REVIEW_ID) throw foreignKeyError();
        if (likes.some((l) => l.userId === userId && l.reviewId === reviewId)) {
          throw uniqueConstraintError();
        }
        likes.push({ userId, reviewId });
        return { userId, reviewId };
      },
      async deleteMany(args: { where: { userId: string; reviewId: string } }) {
        const before = likes.length;
        likes = likes.filter(
          (l) =>
            !(
              l.userId === args.where.userId &&
              l.reviewId === args.where.reviewId
            ),
        );
        return { count: before - likes.length };
      },
      async count(args: { where: { reviewId: string } }) {
        return likes.filter((l) => l.reviewId === args.where.reviewId).length;
      },
    },
    reviewComment: {
      async create(args: {
        data: { reviewId: string; userId: string; body: string };
      }) {
        if (args.data.reviewId !== REVIEW_ID) throw foreignKeyError();
        return {
          id: COMMENT_ID,
          userId: args.data.userId,
          body: args.data.body,
          createdAt: new Date("2026-07-26T09:00:00.000Z"),
          updatedAt: new Date("2026-07-26T09:00:00.000Z"),
          user: {
            profile: {
              username: "viewer",
              displayName: "The Viewer",
              avatarUrl: null,
            },
          },
        };
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    reset(): void {
      likes = [];
    },
  };
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
  let stub: ReturnType<typeof stubPrisma>;

  /** Makes the mocked Clerk SDK accept any bearer token as the viewer. */
  function signIn(): void {
    mockedVerifyToken.mockResolvedValue({
      sub: VIEWER_CLERK,
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);
  }

  beforeAll(async () => {
    stub = stubPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(stub.prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
    stub.reset();
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
    signIn();

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

  it("answers a second POST /reviews/:id/like with 409, not 500", async () => {
    signIn();
    const server = app.getHttpServer();

    const first = await request(server)
      .post(`/reviews/${REVIEW_ID}/like`)
      .set("Authorization", "Bearer valid.jwt.token");
    const second = await request(server)
      .post(`/reviews/${REVIEW_ID}/like`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ likeCount: 1, hasLiked: true });
    // The composite PK refused the second row; the 409 is the honest report.
    expect(second.status).toBe(409);
  });

  it("answers a like on an unknown review with 404, not 500", async () => {
    signIn();

    const res = await request(app.getHttpServer())
      .post(`/reviews/${UNKNOWN_REVIEW_ID}/like`)
      .set("Authorization", "Bearer valid.jwt.token");

    // An unmapped P2003 would escape the service as an unhandled 500 here.
    expect(res.status).toBe(404);
  });

  it("treats DELETE /reviews/:id/like as a tolerant 200 when nothing was liked", async () => {
    signIn();

    const res = await request(app.getHttpServer())
      .delete(`/reviews/${REVIEW_ID}/like`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ likeCount: 0, hasLiked: false });
  });

  it("creates a comment for a signed-in caller (201)", async () => {
    signIn();

    const res = await request(app.getHttpServer())
      .post(`/reviews/${REVIEW_ID}/comments`)
      .set("Authorization", "Bearer valid.jwt.token")
      .send({ body: "Completely agree." });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ body: "Completely agree.", isOwn: true });
  });

  it("rejects an over-long comment body with 400 before any write", async () => {
    signIn();

    const res = await request(app.getHttpServer())
      .post(`/reviews/${REVIEW_ID}/comments`)
      .set("Authorization", "Bearer valid.jwt.token")
      .send({ body: "x".repeat(501) });

    expect(res.status).toBe(400);
  });

  // The load-bearing regression guard for the auth exemption: `@Public()` and
  // `OptionalClerkGuard` live on the READ handler only, so every write must
  // still be rejected by the fail-closed global `ClerkGuard`. If either
  // decorator ever migrated to the class, these would silently turn into 2xx.
  it.each([
    ["post", `/reviews/${REVIEW_ID}/like`],
    ["delete", `/reviews/${REVIEW_ID}/like`],
    ["post", `/reviews/${REVIEW_ID}/comments`],
    ["patch", `/reviews/${REVIEW_ID}/comments/${COMMENT_ID}`],
    ["delete", `/reviews/${REVIEW_ID}/comments/${COMMENT_ID}`],
  ] as const)(
    "rejects %s %s without an Authorization header (401)",
    async (method, path) => {
      const res = await request(app.getHttpServer())[method](path).send({
        body: "Should never be written.",
      });

      expect(res.status).toBe(401);
      expect(mockedVerifyToken).not.toHaveBeenCalled();
    },
  );
});
