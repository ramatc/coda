import { describe, expect, it } from "vitest";
import { sitemapEntriesSchema } from "@coda/types";
import { SitemapService } from "../src/sitemap/sitemap.service.js";
import {
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

interface FindManyArgs {
  where?: { isPublic?: boolean };
  select: Record<string, boolean>;
  take: number;
}

function uuid(n: number): string {
  return `${n}`.padStart(8, "0") + "-0000-4000-8000-000000000000";
}

/**
 * A Prisma double that EXECUTES the parts of the query that decide what leaves
 * the database: the `isPublic` filter, the `select` projection and `take`. The
 * `take` each query asked for is recorded so the caps can be asserted.
 */
function buildService(albums: SeedAlbum[], lists: SeedList[]) {
  const takes: { album?: number; list?: number } = {};

  function project<T extends object>(row: T, select: Record<string, boolean>) {
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => select[key] === true),
    );
  }

  const client = {
    album: {
      findMany: async (args: FindManyArgs) => {
        takes.album = args.take;
        return [...albums]
          .sort((a, b) => b.popularityScore - a.popularityScore)
          .slice(0, args.take)
          .map((row) => project(row, args.select));
      },
    },
    list: {
      findMany: async (args: FindManyArgs) => {
        takes.list = args.take;
        return lists
          .filter(
            (row) =>
              args.where?.isPublic === undefined ||
              row.isPublic === args.where.isPublic,
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, args.take)
          .map((row) => project(row, args.select));
      },
    },
  };

  const service = new SitemapService({ client } as unknown as PrismaService);
  return { service, takes };
}

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

  it("returns empty arrays when the catalog and the lists are empty", async () => {
    const { service } = buildService([], []);

    expect(await service.getEntries()).toEqual({ albums: [], lists: [] });
  });
});
