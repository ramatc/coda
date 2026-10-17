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
// (matches reviews.e2e / lists.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

const VIEWER_CLERK = "user_viewer";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNKNOWN_ALBUM_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const EMPTY_VIEWER = {
  listened: false,
  listenId: null,
  score: null,
  review: null,
  resolved: false,
  wantToListenId: null,
};

/**
 * The narrow Prisma surface `GET /albums/:id` touches, stubbed so the route
 * runs end to end without a live Postgres. Only VIEWER has tracking rows, so
 * the anonymous and signed-in viewer blocks are easy to tell apart.
 */
function stubPrisma() {
  const forViewer = <T>(userId: string, row: T): T | null =>
    userId === VIEWER_ID ? row : null;

  const client = {
    album: {
      async findUnique(args: { where: { id: string } }) {
        if (args.where.id !== ALBUM_ID) {
          return null;
        }
        return {
          id: ALBUM_ID,
          title: "OK Computer",
          coverUrl: null,
          releaseDate: new Date("1997-06-16T00:00:00.000Z"),
          trackCount: 12,
          primaryArtist: { id: "artist-1", name: "Radiohead" },
          genres: [],
          tracks: [],
        };
      },
    },
    rating: {
      async aggregate() {
        return { _avg: { score: 9 }, _count: { _all: 1 } };
      },
      async findUnique(args: {
        where: { userId_albumId: { userId: string } };
      }) {
        return forViewer(args.where.userId_albumId.userId, { score: 9 });
      },
    },
    user: {
      async findUnique(args: { where: { clerkUserId: string } }) {
        return args.where.clerkUserId === VIEWER_CLERK
          ? { id: VIEWER_ID }
          : null;
      },
    },
    listen: {
      async findFirst(args: { where: { userId: string } }) {
        return forViewer(args.where.userId, { id: "listen-1" });
      },
    },
    review: {
      async findUnique() {
        return null;
      },
    },
    wantToListen: {
      async findUnique() {
        return null;
      },
    },
  };
  return { prisma: { client } as unknown as PrismaService };
}

/**
 * HTTP-layer proof that `GET /albums/:id` is anonymous-readable: the global
 * fail-closed `ClerkGuard` must let it through (`@Public()`), while the
 * route-scoped `OptionalClerkGuard` still resolves a signed-in viewer.
 */
describe("Albums API (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(stubPrisma().prisma)
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

  it("serves GET /albums/:id to an anonymous caller with an empty viewer state", async () => {
    const res = await request(app.getHttpServer()).get(`/albums/${ALBUM_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("OK Computer");
    expect(res.body.aggregateRating).toEqual({ average: 9, count: 1 });
    expect(res.body.viewer).toEqual(EMPTY_VIEWER);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("resolves a signed-in caller's own viewer state on the same route", async () => {
    mockedVerifyToken.mockResolvedValue({
      sub: VIEWER_CLERK,
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);

    const res = await request(app.getHttpServer())
      .get(`/albums/${ALBUM_ID}`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body.viewer).toMatchObject({
      listened: true,
      listenId: "listen-1",
      score: 9,
      resolved: true,
    });
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("degrades an expired or tampered token to anonymous (200, not 401)", async () => {
    mockedVerifyToken.mockRejectedValue(new Error("token expired"));

    const res = await request(app.getHttpServer())
      .get(`/albums/${ALBUM_ID}`)
      .set("Authorization", "Bearer expired.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body.viewer).toEqual(EMPTY_VIEWER);
  });

  it("answers an unknown album id with 404 for an anonymous caller", async () => {
    const res = await request(app.getHttpServer()).get(
      `/albums/${UNKNOWN_ALBUM_ID}`,
    );

    expect(res.status).toBe(404);
  });

  it.each([
    ["POST", "/listens"],
    ["PUT", "/ratings"],
    ["POST", "/reviews"],
    ["DELETE", `/ratings/${ALBUM_ID}`],
  ] as const)(
    "keeps the tracking write %s %s behind the global ClerkGuard (anonymous → 401)",
    async (method, path) => {
      const server = request(app.getHttpServer());
      const res = await (method === "POST"
        ? server.post(path)
        : method === "PUT"
          ? server.put(path)
          : server.delete(path));

      expect(res.status).toBe(401);
    },
  );
});
