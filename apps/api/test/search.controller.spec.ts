import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { SearchController } from "../src/search/search.controller.js";
import type { SearchService } from "../src/search/search.service.js";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";

const popularAlbum = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "OK Computer",
  coverUrl: null,
  primaryArtistName: "Radiohead",
};

const searchResults = {
  query: "radiohead",
  page: 1,
  limit: 20,
  albums: [],
  artists: [],
  totalAlbums: 0,
  totalArtists: 0,
};

/**
 * Unit test for {@link SearchController}. Two jobs:
 *
 * 1. Prove each handler is a thin pass-through to {@link SearchService}.
 * 2. Pin the exact placement of `@Public()`. The landing page reads
 *    `GET /search/popular` anonymously, so that ONE handler is exempt from the
 *    global fail-closed `ClerkGuard`. On the CLASS the same decorator would also
 *    exempt `GET /search` — and every route added to this controller later —
 *    because `ClerkGuard` resolves it with `getAllAndOverride([handler, class])`.
 *    These assertions are the regression guard for that, mirroring
 *    `reviews.controller.spec.ts`.
 */
describe("SearchController", () => {
  let search: ReturnType<typeof vi.fn>;
  let popularAlbums: ReturnType<typeof vi.fn>;
  let controller: SearchController;

  beforeEach(() => {
    search = vi.fn().mockResolvedValue(searchResults);
    popularAlbums = vi.fn().mockResolvedValue([popularAlbum]);
    controller = new SearchController({
      search,
      popularAlbums,
    } as unknown as SearchService);
  });

  it("GET /search/popular forwards the limit and returns the albums", async () => {
    const result = await controller.popular("8");

    expect(popularAlbums).toHaveBeenCalledWith("8");
    expect(result).toEqual([popularAlbum]);
  });

  it("GET /search forwards the query, page and limit untouched", async () => {
    const result = await controller.query("radiohead", "2", "10");

    expect(search).toHaveBeenCalledWith("radiohead", "2", "10");
    expect(result).toBe(searchResults);
  });

  it("marks popular @Public() at METHOD level and never at class level", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, SearchController.prototype.popular),
    ).toBe(true);
    // A class-level @Public() would also exempt `GET /search` and every future
    // handler added to this controller.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, SearchController)).toBe(
      undefined,
    );
  });

  it("leaves GET /search behind the global guard (no @Public() on query)", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, SearchController.prototype.query),
    ).toBe(undefined);
  });

  it("applies no route-scoped guard to popular (no OptionalClerkGuard)", () => {
    // Nothing in the PopularAlbum payload depends on the viewer, so resolving a
    // caller would be dead weight on an anonymous-by-design route.
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SearchController.prototype.popular),
    ).toBe(undefined);
    expect(Reflect.getMetadata(GUARDS_METADATA, SearchController)).toBe(
      undefined,
    );
  });
});
