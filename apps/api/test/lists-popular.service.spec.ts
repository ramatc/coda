import { describe, expect, it } from "vitest";
import { ListsService } from "../src/lists/lists.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import {
  DEFAULT_POPULAR_LIST_LIMIT,
  LIST_PREVIEW_COVER_COUNT,
  MAX_POPULAR_LIST_LIMIT,
  POPULAR_LIST_MIN_ITEMS,
} from "../src/lists/lists.constants.js";

/** One stored item on a seeded list: its position and its album's cover. */
interface SeedItem {
  position: number;
  coverUrl: string | null;
}

/** A stored list row, before the service projects it to `PopularList`. */
interface SeedList {
  id: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: Date;
  items: SeedItem[];
  likes: number;
  profile: {
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

/** `count` items, each with a distinct cover, at positions `1..count`. */
function coveredItems(count: number): SeedItem[] {
  return Array.from({ length: count }, (_, i) => ({
    position: i + 1,
    coverUrl: `https://cdn.example/cover-${i + 1}.jpg`,
  }));
}

function seed(overrides: Partial<SeedList> = {}): SeedList {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Late-night records",
    description: "For the drive home.",
    isRanked: false,
    isPublic: true,
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    items: coveredItems(POPULAR_LIST_MIN_ITEMS),
    likes: 3,
    profile: {
      username: "curator",
      displayName: "The Curator",
      avatarUrl: null,
    },
    ...overrides,
  };
}

/** Ids that sort deterministically, so the `id` tiebreak is observable. */
function listId(n: number): string {
  return `${n}`.padStart(8, "0") + "-0000-4000-8000-000000000000";
}

/** The nested `items` args the service is expected to build for the covers. */
interface ItemsArgs {
  where: { album: { coverUrl: { not: null } } };
  orderBy: { position: "asc" };
  take: number;
}

/** The `findMany` args the service is expected to build. */
interface FindManyArgs {
  where: { isPublic: boolean };
  orderBy: { createdAt?: "desc"; id?: "desc" }[];
  take: number;
  select: { items: ItemsArgs };
}

/**
 * A Prisma double that really EXECUTES the query the service builds: it applies
 * `where.isPublic`, `orderBy`, `take`, and the nested `items` filter / order /
 * take against the seeded rows, and reports `_count.items` over ALL of a list's
 * items (not just the covered ones), exactly as Postgres would.
 *
 * Asserting the args object alone would prove only that the service typed a
 * literal. Running the filter means the exclusion assertions below fail for the
 * real reason: the row survived the query or the in-memory floor.
 */
function fakePrisma(rows: SeedList[]) {
  const calls: FindManyArgs[] = [];

  const client = {
    list: {
      async findMany(args: FindManyArgs) {
        calls.push(args);
        const itemArgs = args.select.items;
        return rows
          .filter((row) => row.isPublic === args.where.isPublic)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(0, args.take)
          .map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description,
            isRanked: row.isRanked,
            createdAt: row.createdAt,
            user: { profile: row.profile },
            items: row.items
              .filter((item) => item.coverUrl !== null)
              .sort((a, b) => a.position - b.position)
              .slice(0, itemArgs.take)
              .map((item) => ({ album: { coverUrl: item.coverUrl } })),
            _count: { items: row.items.length, likes: row.likes },
          }));
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    lastCall: (): FindManyArgs => {
      const call = calls.at(-1);
      if (!call) throw new Error("list.findMany was never called.");
      return call;
    },
  };
}

function buildService(rows: SeedList[]): {
  service: ListsService;
  lastCall: () => FindManyArgs;
} {
  const { prisma, lastCall } = fakePrisma(rows);
  return { service: new ListsService(prisma), lastCall };
}

/**
 * Unit test for the public landing page's `GET /lists/popular` read
 * (`ListsService.popularLists`). Kept in its own file rather than appended to
 * `lists.service.spec.ts`, mirroring `reviews-popular.service.spec.ts`: this is
 * a standalone landing-page work unit, and the CRUD spec's shared in-memory
 * fake keys `list.findMany` on a single owner, which this cross-user read does
 * not have.
 */
describe("ListsService.popularLists", () => {
  it("projects an eligible public list into the landing-page card shape", async () => {
    const { service } = buildService([seed()]);

    const popular = await service.popularLists();

    expect(popular).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Late-night records",
        description: "For the drive home.",
        isRanked: false,
        itemCount: POPULAR_LIST_MIN_ITEMS,
        likeCount: 3,
        createdAt: "2026-07-25T10:00:00.000Z",
        owner: {
          username: "curator",
          displayName: "The Curator",
          avatarUrl: null,
        },
        previewCovers: coveredItems(POPULAR_LIST_MIN_ITEMS).map(
          (item) => item.coverUrl,
        ),
      },
    ]);
  });

  it("never returns a private list, even one that meets the item floor", async () => {
    const { service, lastCall } = buildService([
      seed({ id: listId(1), title: "Private stash", isPublic: false }),
      seed({ id: listId(2), title: "Shared shelf", isPublic: true }),
    ]);

    const popular = await service.popularLists();

    expect(popular.map((list) => list.title)).toEqual(["Shared shelf"]);
    expect(lastCall().where).toEqual({ isPublic: true });
  });

  it("excludes a public list below the item floor and keeps the boundary count", async () => {
    const { service } = buildService([
      seed({
        id: listId(1),
        title: "Sparse",
        items: coveredItems(POPULAR_LIST_MIN_ITEMS - 1),
      }),
      seed({
        id: listId(2),
        title: "Exactly enough",
        items: coveredItems(POPULAR_LIST_MIN_ITEMS),
      }),
    ]);

    const popular = await service.popularLists();

    // The sparse row reached the service and was dropped by the floor.
    expect(popular.map((list) => list.title)).toEqual(["Exactly enough"]);
    expect(popular[0].itemCount).toBe(POPULAR_LIST_MIN_ITEMS);
  });

  it("orders by createdAt descending with an id tiebreak, newest first", async () => {
    const { service, lastCall } = buildService([
      seed({
        id: listId(1),
        title: "Older",
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
      }),
      seed({
        id: listId(2),
        title: "Newer",
        createdAt: new Date("2026-07-20T10:00:00.000Z"),
      }),
    ]);

    const popular = await service.popularLists();

    expect(popular.map((list) => list.title)).toEqual(["Newer", "Older"]);
    expect(lastCall().orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("over-fetches limit * 3 candidates, then slices the eligible ones to the limit", async () => {
    // Newest first: two sparse lists sit ahead of the eligible ones, so a
    // plain `take: limit` would have returned nothing usable.
    const rows = [
      seed({ id: listId(6), title: "Sparse A", items: coveredItems(1) }),
      seed({ id: listId(5), title: "Sparse B", items: coveredItems(2) }),
      seed({ id: listId(4), title: "Full A" }),
      seed({ id: listId(3), title: "Full B" }),
      seed({ id: listId(2), title: "Full C" }),
      seed({ id: listId(1), title: "Full D" }),
    ].map((row, i) => ({
      ...row,
      createdAt: new Date(Date.UTC(2026, 6, 20 - i)),
    }));
    const { service, lastCall } = buildService(rows);

    const popular = await service.popularLists(2);

    expect(lastCall().take).toBe(6);
    expect(popular.map((list) => list.title)).toEqual(["Full A", "Full B"]);
  });

  it("bounds the read to the default limit with no cursor in the payload", async () => {
    const rows = Array.from(
      { length: DEFAULT_POPULAR_LIST_LIMIT + 5 },
      (_, i) =>
        seed({
          id: listId(i),
          createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)),
        }),
    );
    const { service, lastCall } = buildService(rows);

    const popular = await service.popularLists();

    expect(popular).toHaveLength(DEFAULT_POPULAR_LIST_LIMIT);
    expect(lastCall().take).toBe(DEFAULT_POPULAR_LIST_LIMIT * 3);
    expect(popular[0]).not.toHaveProperty("nextCursor");
  });

  it("clamps an oversized limit, capping the candidate window at 36 rows", async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      seed({
        id: listId(i),
        createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)),
      }),
    );
    const { service, lastCall } = buildService(rows);

    const popular = await service.popularLists(MAX_POPULAR_LIST_LIMIT + 50);

    expect(lastCall().take).toBe(36);
    expect(popular).toHaveLength(MAX_POPULAR_LIST_LIMIT);
  });

  it("parses a query-string limit and falls back on an unusable one", async () => {
    const { service, lastCall } = buildService([seed()]);

    // Express hands query params over as strings.
    await service.popularLists("4");
    expect(lastCall().take).toBe(12);

    await service.popularLists("not-a-number");
    expect(lastCall().take).toBe(DEFAULT_POPULAR_LIST_LIMIT * 3);

    await service.popularLists(0);
    expect(lastCall().take).toBe(DEFAULT_POPULAR_LIST_LIMIT * 3);
  });

  it("builds previewCovers from the first covered items by position, capped at the preview count", async () => {
    const items: SeedItem[] = [
      { position: 3, coverUrl: "https://cdn.example/third.jpg" },
      { position: 1, coverUrl: "https://cdn.example/first.jpg" },
      { position: 2, coverUrl: null },
      { position: 4, coverUrl: "https://cdn.example/fourth.jpg" },
      { position: 5, coverUrl: "https://cdn.example/fifth.jpg" },
      { position: 6, coverUrl: "https://cdn.example/sixth.jpg" },
    ];
    const { service, lastCall } = buildService([seed({ items })]);

    const [list] = await service.popularLists();

    // Position order, the cover-less item skipped, then cut to four.
    expect(list.previewCovers).toEqual([
      "https://cdn.example/first.jpg",
      "https://cdn.example/third.jpg",
      "https://cdn.example/fourth.jpg",
      "https://cdn.example/fifth.jpg",
    ]);
    // The item count still reflects EVERY item, not just the covered ones.
    expect(list.itemCount).toBe(6);
    // Bounded in the query too: no card loads its whole item list.
    expect(lastCall().select.items).toEqual({
      where: { album: { coverUrl: { not: null } } },
      orderBy: { position: "asc" },
      take: LIST_PREVIEW_COVER_COUNT,
      select: { album: { select: { coverUrl: true } } },
    });
  });

  it("degrades a list whose owner has no profile row instead of throwing", async () => {
    const { service } = buildService([seed({ profile: null })]);

    const [list] = await service.popularLists();

    expect(list.owner).toEqual({
      username: "",
      displayName: "",
      avatarUrl: null,
    });
  });
});
