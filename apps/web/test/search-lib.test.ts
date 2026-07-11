import { afterEach, describe, expect, it, vi } from "vitest";
import { albumHref, fetchPopularAlbums, searchCatalog } from "../lib/search";

/**
 * Pure/fail-safe behaviors of the search lib: the album route helper, and the
 * two fetch helpers' graceful degradation (empty query short-circuit + non-OK
 * fail-safe), mirroring `lib/onboarding.ts`'s posture.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search lib", () => {
  it("albumHref points at the album detail route", () => {
    expect(albumHref("abc")).toBe("/albums/abc");
  });

  it("searchCatalog short-circuits an empty/whitespace query without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchCatalog("t", "")).toBeNull();
    expect(await searchCatalog("t", "   ")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searchCatalog returns null on a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await searchCatalog("t", "radiohead")).toBeNull();
  });

  it("fetchPopularAlbums fails safe to an empty list on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await fetchPopularAlbums("t")).toEqual([]);
  });
});
