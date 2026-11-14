import { afterEach, describe, expect, it, vi } from "vitest";
import { sitemapEntriesSchema } from "@coda/types";
import { SitemapService } from "../src/sitemap/sitemap.service.js";
import {
  SITEMAP_CACHE_TTL_MS,
  SITEMAP_MAX_ALBUMS,
  SITEMAP_MAX_LISTS,
} from "../src/sitemap/sitemap.constants.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

interface SeedAlbum {
  id: string;
  popularityScore: number;
  updatedAt: Date;
}

interface SeedList {
  id: string;
  isPublic: boolean;
  updatedAt: Date;
}

type Direction = "asc" | "desc";
type Sortable = string | number | Date;

interface FindManyArgs {
  where?: { isPublic?: boolean };
  select: Record<string, boolean>;
  orderBy: Record<string, Direction>[];
  take: number;
}

/** Sorts rows by the `orderBy` the service built, the way Postgres would. */
function applyOrderBy<T extends object>(
  rows: T[],
  orderBy: Record<string, Direction>[],
): T[] {
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      for (const [field, direction] of Object.entries(clause)) {
        const left = (a as Record<string, Sortable>)[field] as Sortable;
        const right = (b as Record<string, Sortable>)[field] as Sortable;
        if (left < right) return direction === "asc" ? -1 : 1;
        if (left > right) return direction === "asc" ? 1 : -1;
      }
    }
    return 0;
  });
}

function uuid(n: number): string {
  return `${n}`.padStart(8, "0") + "-0000-4000-8000-000000000000";
}

/**
 * A Prisma double that EXECUTES the query the service builds: the `isPublic`
 * filter, `orderBy`, `take` and the `select` projection. The `take` each query
 * asked for and the number of reads are recorded, and `control.failNext` makes
 * the next read reject.
 */
function buildService(albums: SeedAlbum[], lists: SeedList[]) {
  const takes: { album?: number; list?: number } = {};
  const control = { reads: 0, failNext: false };

  function project<T extends object>(row: T, select: Record<string, boolean>) {
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => select[key] === true),
    );
  }

  const client = {
    album: {
      findMany: async (args: FindManyArgs) => {
        takes.album = args.take;
        control.reads += 1;
        if (control.failNext) {
          control.failNext = false;
          throw new Error("database unavailable");
        }
        return applyOrderBy(albums, args.orderBy)
          .slice(0, args.take)
          .map((row) => project(row, args.select));
      },
    },
    list: {
      findMany: async (args: FindManyArgs) => {
        takes.list = args.take;
        return applyOrderBy(
          lists.filter(
            (row) =>
              args.where?.isPublic === undefined ||
              row.isPublic === args.where.isPublic,
          ),
          args.orderBy,
        )
          .slice(0, args.take)
          .map((row) => project(row, args.select));
      },
    },
  };

  const service = new SitemapService({ client } as unknown as PrismaService);
  return { service, takes, control };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SitemapService.getEntries", () => {
  it("returns every album with its id and last-modified time, most popular first", async () => {
    const { service } = buildService(
      [
        {
          id: uuid(1),
          popularityScore: 10,
          updatedAt: new Date("2026-10-01T08:00:00.000Z"),
        },
        {
          id: uuid(2),
          popularityScore: 90,
          updatedAt: new Date("2026-10-02T09:30:00.000Z"),
        },
      ],
      [],
    );

    const entries = await service.getEntries();

    expect(entries.albums).toEqual([
      { id: uuid(2), updatedAt: "2026-10-02T09:30:00.000Z" },
      { id: uuid(1), updatedAt: "2026-10-01T08:00:00.000Z" },
    ]);
  });

  it("returns public lists and never a private one", async () => {
    const { service } = buildService(
      [],
      [
        {
          id: uuid(11),
          isPublic: true,
          updatedAt: new Date("2026-10-03T10:00:00.000Z"),
        },
        {
          id: uuid(12),
          isPublic: false,
          updatedAt: new Date("2026-10-04T10:00:00.000Z"),
        },
        {
          id: uuid(13),
          isPublic: true,
          updatedAt: new Date("2026-10-05T10:00:00.000Z"),
        },
      ],
    );

    const entries = await service.getEntries();

    expect(entries.lists).toEqual([
      { id: uuid(13), updatedAt: "2026-10-05T10:00:00.000Z" },
      { id: uuid(11), updatedAt: "2026-10-03T10:00:00.000Z" },
    ]);
  });

  it("exposes nothing beyond id and updatedAt, matching the shared contract", async () => {
    const { service } = buildService(
      [
        {
          id: uuid(1),
          popularityScore: 5,
          updatedAt: new Date("2026-10-01T08:00:00.000Z"),
        },
      ],
      [
        {
          id: uuid(11),
          isPublic: true,
          updatedAt: new Date("2026-10-03T10:00:00.000Z"),
        },
      ],
    );

    const entries = await service.getEntries();

    expect(Object.keys(entries.albums[0] ?? {}).sort()).toEqual([
      "id",
      "updatedAt",
    ]);
    expect(Object.keys(entries.lists[0] ?? {}).sort()).toEqual([
      "id",
      "updatedAt",
    ]);
    expect(sitemapEntriesSchema.parse(entries)).toEqual(entries);
  });

  it("caps both queries so one sitemap file stays under the 50,000-URL limit", async () => {
    const { service, takes } = buildService([], []);

    await service.getEntries();

    expect(takes).toEqual({
      album: SITEMAP_MAX_ALBUMS,
      list: SITEMAP_MAX_LISTS,
    });
    expect(SITEMAP_MAX_ALBUMS + SITEMAP_MAX_LISTS).toBeLessThan(50_000);
  });

  it("breaks ties by id so the capped cut is deterministic", async () => {
    const sameTime = new Date("2026-10-03T10:00:00.000Z");
    const { service } = buildService(
      [
        { id: uuid(2), popularityScore: 7, updatedAt: sameTime },
        { id: uuid(1), popularityScore: 7, updatedAt: sameTime },
      ],
      [
        { id: uuid(12), isPublic: true, updatedAt: sameTime },
        { id: uuid(11), isPublic: true, updatedAt: sameTime },
      ],
    );

    const entries = await service.getEntries();

    expect(entries.albums.map((entry) => entry.id)).toEqual([uuid(1), uuid(2)]);
    expect(entries.lists.map((entry) => entry.id)).toEqual([
      uuid(11),
      uuid(12),
    ]);
  });

  it("serves repeat callers from memory until the cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    const { service, control } = buildService([], []);

    await service.getEntries();
    await service.getEntries();
    expect(control.reads).toBe(1);

    vi.advanceTimersByTime(SITEMAP_CACHE_TTL_MS + 1);
    await service.getEntries();
    expect(control.reads).toBe(2);
  });

  it("shares one database read between concurrent callers", async () => {
    const { service, control } = buildService([], []);

    await Promise.all([service.getEntries(), service.getEntries()]);

    expect(control.reads).toBe(1);
  });

  it("does not cache a failed read", async () => {
    const { service, control } = buildService([], []);
    control.failNext = true;

    await expect(service.getEntries()).rejects.toThrow("database unavailable");
    expect(await service.getEntries()).toEqual({ albums: [], lists: [] });
  });

  it("returns empty arrays when the catalog and the lists are empty", async () => {
    const { service } = buildService([], []);

    expect(await service.getEntries()).toEqual({ albums: [], lists: [] });
  });
});
