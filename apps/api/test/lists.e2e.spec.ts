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
// (matches reviews.e2e / social.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

const PUBLIC_LIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRIVATE_LIST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SPARSE_LIST_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OLDER_LIST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const OWNER = {
  profile: { username: "curator", displayName: "The Curator", avatarUrl: null },
};

/** Builds `count` preview-cover item rows, as the nested `items` select returns. */
function covers(count: number): { album: { coverUrl: string } }[] {
  return Array.from({ length: count }, (_, i) => ({
    album: { coverUrl: `https://cdn.example/cover-${i + 1}.jpg` },
  }));
}

/**
 * Rows behind `GET /lists/popular`, newest first: an eligible public list, a
 * private list that meets the item floor, a public list below the floor, and a
 * second eligible public list — so the public payload can be proven to drop
 * exactly the private and the sparse ones.
 */
const LIST_ROWS = [
  {
    id: PUBLIC_LIST_ID,
    title: "Late-night records",
    description: null,
    isRanked: false,
    isPublic: true,
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    user: OWNER,
    items: covers(4),
    _count: { items: 5, likes: 2 },
  },
  {
    id: PRIVATE_LIST_ID,
    title: "Private stash",
    description: null,
    isRanked: false,
    isPublic: false,
    createdAt: new Date("2026-07-24T10:00:00.000Z"),
    user: OWNER,
    items: covers(4),
    _count: { items: 8, likes: 0 },
  },
  {
    id: SPARSE_LIST_ID,
    title: "Just started",
    description: null,
    isRanked: false,
    isPublic: true,
    createdAt: new Date("2026-07-23T10:00:00.000Z"),
    user: OWNER,
    items: covers(1),
    _count: { items: 1, likes: 0 },
  },
  {
    id: OLDER_LIST_ID,
    title: "Ranked favourites",
    description: "Top of the pile.",
    isRanked: true,
    isPublic: true,
    createdAt: new Date("2026-07-22T10:00:00.000Z"),
    user: OWNER,
    items: covers(3),
    _count: { items: 3, likes: 7 },
  },
];

const OWNER_CLERK = "user_owner";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VISITOR_CLERK = "user_visitor";
const VISITOR_ID = "22222222-2222-4222-8222-222222222222";

/** Rows behind `GET /lists/:id`: one public and one private list of OWNER. */
const DETAIL_ROWS = [PUBLIC_LIST_ID, PRIVATE_LIST_ID].map((id) => ({
  id,
  userId: OWNER_ID,
  title: id === PUBLIC_LIST_ID ? "Late-night records" : "Private stash",
  description: null,
  isRanked: false,
  isPublic: id === PUBLIC_LIST_ID,
  createdAt: new Date("2026-07-25T10:00:00.000Z"),
  updatedAt: new Date("2026-07-25T10:00:00.000Z"),
  _count: { likes: 2 },
  items: [],
}));

/**
 * The narrow Prisma surface `GET /lists/popular` touches, stubbed so the route
 * runs end to end without a live Postgres (the project's no-docker sandbox
 * convention). `findMany` honours `where.isPublic` and `take`, so the private
 * list is dropped by the query and the bound is observable; the item floor is
 * left to the service, which is exactly where the design places it.
 */
function stubPrisma() {
  const client = {
    user: {
      async findUnique(args: { where: { clerkUserId: string } }) {
        if (args.where.clerkUserId === OWNER_CLERK) {
          return { id: OWNER_ID };
        }
        return args.where.clerkUserId === VISITOR_CLERK
          ? { id: VISITOR_ID }
          : null;
      },
    },
    list: {
      async findMany(args: { where: { isPublic: boolean }; take: number }) {
        return LIST_ROWS.filter(
          (row) => row.isPublic === args.where.isPublic,
        ).slice(0, args.take);
      },
      // Serves both the access-check row and the detail select.
      async findUnique(args: { where: { id: string } }) {
        return DETAIL_ROWS.find((row) => row.id === args.where.id) ?? null;
      },
    },
    listLike: {
      async findUnique(args: { where: { userId_listId: { userId: string } } }) {
        return args.where.userId_listId.userId === OWNER_ID
          ? { userId: OWNER_ID }
          : null;
      },
    },
  };
  return { prisma: { client } as unknown as PrismaService };
}

/**
 * HTTP-layer proof for the lists module's only anonymous-readable route. The
 * controller spec asserts decorator placement and declaration order, but only
 * a real request through Nest's router and the global fail-closed `ClerkGuard`
 * proves that `/lists/popular` reaches `popularLists` (not `getList("popular")`)
 * and that an anonymous caller gets 200 rather than 401.
 */
describe("Lists API (e2e)", () => {
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

  it("serves GET /lists/popular to an anonymous caller (200 array, never 401)", async () => {
    const res = await request(app.getHttpServer()).get("/lists/popular");

    // A 400 here would mean `@Get("lists/:id")` matched first and the UUID
    // guard rejected the literal string "popular" — the route-order regression
    // this landing-page endpoint is most exposed to.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({
      id: PUBLIC_LIST_ID,
      title: "Late-night records",
      itemCount: 5,
      likeCount: 2,
      owner: { username: "curator" },
      previewCovers: covers(4).map((item) => item.album.coverUrl),
    });
    // Bounded top-N, not a page: no cursor rides along in the payload.
    expect(res.body[0]).not.toHaveProperty("nextCursor");
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("omits private and below-floor lists from the public payload", async () => {
    const res = await request(app.getHttpServer()).get("/lists/popular");

    expect(res.status).toBe(200);
    expect(res.body.map((list: { id: string }) => list.id)).toEqual([
      PUBLIC_LIST_ID,
      OLDER_LIST_ID,
    ]);
  });

  it("clamps ?limit= on GET /lists/popular instead of rejecting it", async () => {
    const res = await request(app.getHttpServer()).get(
      "/lists/popular?limit=1",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((list: { id: string }) => list.id)).toEqual([
      PUBLIC_LIST_ID,
    ]);
  });

  it("serves a PUBLIC list on GET /lists/:id to an anonymous caller (200, never 401)", async () => {
    const res = await request(app.getHttpServer()).get(
      `/lists/${PUBLIC_LIST_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: PUBLIC_LIST_ID,
      likeCount: 2,
      viewerHasLiked: false,
    });
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("hides a PRIVATE list from an anonymous caller (404, not 401)", async () => {
    const res = await request(app.getHttpServer()).get(
      `/lists/${PRIVATE_LIST_ID}`,
    );

    expect(res.status).toBe(404);
  });

  it("resolves a signed-in owner on GET /lists/:id (private list + their like)", async () => {
    mockedVerifyToken.mockResolvedValue({
      sub: OWNER_CLERK,
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);

    const res = await request(app.getHttpServer())
      .get(`/lists/${PRIVATE_LIST_ID}`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: PRIVATE_LIST_ID,
      viewerHasLiked: true,
    });
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("hides a PRIVATE list from a signed-in NON-owner (404)", async () => {
    mockedVerifyToken.mockResolvedValue({
      sub: VISITOR_CLERK,
      sid: "sess_2",
    } as Awaited<ReturnType<typeof verifyToken>>);

    const res = await request(app.getHttpServer())
      .get(`/lists/${PRIVATE_LIST_ID}`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(404);
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
  });

  it("degrades an expired or tampered token on GET /lists/:id to anonymous", async () => {
    mockedVerifyToken.mockRejectedValue(new Error("token expired"));

    const res = await request(app.getHttpServer())
      .get(`/lists/${PRIVATE_LIST_ID}`)
      .set("Authorization", "Bearer expired.jwt.token");

    expect(res.status).toBe(404);
  });

  it.each([
    ["PATCH", `/lists/${PUBLIC_LIST_ID}`],
    ["DELETE", `/lists/${PUBLIC_LIST_ID}`],
    ["POST", `/lists/${PUBLIC_LIST_ID}/like`],
    ["POST", "/lists"],
    ["GET", "/users/curator/lists"],
    ["DELETE", `/lists/${PUBLIC_LIST_ID}/like`],
    ["POST", `/lists/${PUBLIC_LIST_ID}/items`],
    ["PATCH", `/lists/${PUBLIC_LIST_ID}/items/reorder`],
    ["DELETE", `/lists/${PUBLIC_LIST_ID}/items/item-1`],
  ] as const)(
    "keeps %s %s behind the global ClerkGuard (anonymous → 401)",
    async (method, path) => {
      // The public read must not leak its exemption to its siblings.
      const server = request(app.getHttpServer());
      const res = await (method === "GET"
        ? server.get(path)
        : method === "POST"
          ? server.post(path)
          : method === "PATCH"
            ? server.patch(path)
            : server.delete(path));

      expect(res.status).toBe(401);
    },
  );
});
