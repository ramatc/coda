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

/**
 * The narrow Prisma surface `GET /lists/popular` touches, stubbed so the route
 * runs end to end without a live Postgres (the project's no-docker sandbox
 * convention). `findMany` honours `where.isPublic` and `take`, so the private
 * list is dropped by the query and the bound is observable; the item floor is
 * left to the service, which is exactly where the design places it.
 */
function stubPrisma() {
  const client = {
    list: {
      async findMany(args: { where: { isPublic: boolean }; take: number }) {
        return LIST_ROWS.filter(
          (row) => row.isPublic === args.where.isPublic,
        ).slice(0, args.take);
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

  it("keeps GET /lists/:id behind the global ClerkGuard (anonymous → 401)", async () => {
    // The public route must not leak its exemption to its `:id` sibling.
    const res = await request(app.getHttpServer()).get(
      `/lists/${PUBLIC_LIST_ID}`,
    );

    expect(res.status).toBe(401);
  });
});
