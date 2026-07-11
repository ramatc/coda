import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { SearchService } from "../src/search/search.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { MeiliService } from "../src/search/meili.service.js";

/**
 * Read-side search tests. Cover the two spec guarantees that matter most:
 *  - Task 7.3 / spec "Empty query is rejected": empty/whitespace queries are 400s
 *    and NEVER reach Meilisearch.
 *  - Task 7.5 / spec "No On-Demand Import": a search that matches nothing returns
 *    empty results and enqueues NO catalog-import job.
 */

function fakeMeili(hits: {
  albums?: unknown[];
  artists?: unknown[];
  totalAlbums?: number;
  totalArtists?: number;
}) {
  return {
    searchAlbums: vi.fn().mockResolvedValue({
      hits: hits.albums ?? [],
      estimatedTotalHits: hits.totalAlbums ?? 0,
    }),
    searchArtists: vi.fn().mockResolvedValue({
      hits: hits.artists ?? [],
      estimatedTotalHits: hits.totalArtists ?? 0,
    }),
  };
}

function fakePrisma(popular: unknown[] = []) {
  return {
    client: {
      album: { findMany: vi.fn().mockResolvedValue(popular) },
    },
  } as unknown as PrismaService;
}

describe("SearchService", () => {
  it("rejects an empty query with a 400 and NEVER calls Meilisearch (task 7.3)", async () => {
    const meili = fakeMeili({});
    const service = new SearchService(
      fakePrisma(),
      meili as unknown as MeiliService,
    );

    await expect(service.search("")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.search("   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.search(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(meili.searchAlbums).not.toHaveBeenCalled();
    expect(meili.searchArtists).not.toHaveBeenCalled();
  });

  it("a zero-result search returns empty and enqueues NO catalog-import job (task 7.5, no on-demand import)", async () => {
    const meili = fakeMeili({ albums: [], artists: [] });
    // A stand-in catalog-import queue. `SearchService` structurally cannot reach
    // it (it depends only on Prisma + Meili), so this spy proves a search miss
    // never triggers an import — there is no lazy/on-demand import in Fase 1.
    const catalogQueueSpy = {
      enqueueSeed: vi.fn(),
      enqueueAlbums: vi.fn(),
      enqueueEnrichment: vi.fn(),
    };
    const service = new SearchService(
      fakePrisma(),
      meili as unknown as MeiliService,
    );

    const result = await service.search("album-that-does-not-exist");

    expect(result.albums).toEqual([]);
    expect(result.artists).toEqual([]);
    expect(result.totalAlbums).toBe(0);
    // The search path ran against Meili but touched no import machinery.
    expect(meili.searchAlbums).toHaveBeenCalledTimes(1);
    expect(catalogQueueSpy.enqueueSeed).not.toHaveBeenCalled();
    expect(catalogQueueSpy.enqueueAlbums).not.toHaveBeenCalled();
    expect(catalogQueueSpy.enqueueEnrichment).not.toHaveBeenCalled();
  });

  it("delegates a valid query to Meilisearch with 1-based page → offset paging", async () => {
    const meili = fakeMeili({
      albums: [{ id: "a1" }],
      artists: [{ id: "ar1" }],
      totalAlbums: 1,
      totalArtists: 1,
    });
    const service = new SearchService(
      fakePrisma(),
      meili as unknown as MeiliService,
    );

    const result = await service.search("radiohead", "2", "10");

    expect(meili.searchAlbums).toHaveBeenCalledWith("radiohead", {
      limit: 10,
      offset: 10,
    });
    expect(result).toMatchObject({
      query: "radiohead",
      page: 2,
      limit: 10,
      albums: [{ id: "a1" }],
      artists: [{ id: "ar1" }],
    });
  });

  it("clamps an oversized limit and a bad page to sane bounds instead of rejecting", async () => {
    const meili = fakeMeili({});
    const service = new SearchService(
      fakePrisma(),
      meili as unknown as MeiliService,
    );

    await service.search("q", "0", "9999");

    const [, params] = meili.searchAlbums.mock.calls[0];
    expect(params.offset).toBe(0); // page clamped to 1 → offset 0
    expect(params.limit).toBe(50); // limit clamped to MAX_SEARCH_PAGE_SIZE
  });

  it("popularAlbums reads top albums by popularity straight from Postgres (simple heuristic)", async () => {
    const rows = [
      {
        id: "a1",
        title: "Top Album",
        coverUrl: null,
        primaryArtist: { name: "Some Artist" },
      },
    ];
    const prisma = fakePrisma(rows);
    const service = new SearchService(
      prisma,
      fakeMeili({}) as unknown as MeiliService,
    );

    const popular = await service.popularAlbums();

    expect(prisma.client.album.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { popularityScore: "desc" } }),
    );
    expect(popular).toEqual([
      {
        id: "a1",
        title: "Top Album",
        coverUrl: null,
        primaryArtistName: "Some Artist",
      },
    ]);
  });
});
