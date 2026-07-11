import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { MeiliService } from "../src/search/meili.service.js";
import {
  ALBUMS_INDEX,
  ALBUMS_INDEX_SETTINGS,
  ARTISTS_INDEX,
  ARTISTS_INDEX_SETTINGS,
} from "../src/search/search.constants.js";
import type { AlbumSearchDocument } from "../src/search/search-document.js";

/**
 * `MeiliService` talks to Meilisearch's REST API over the global `fetch`
 * (dependency-free, matching how `SpotifyClient`/`MusicBrainzClient` wrap their
 * upstreams). These tests stub `fetch` so there is no live Meilisearch — the
 * sandbox convention from PR5/PR6.
 */

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function config(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(
  calls: FakeCall[],
  responder: (call: FakeCall) => Response = () => okResponse(),
) {
  const fetchMock = vi.fn(
    async (url: string, init: RequestInit): Promise<Response> => {
      const call: FakeCall = {
        url,
        method: init.method ?? "GET",
        headers: (init.headers as Record<string, string>) ?? {},
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      return responder(call);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const albumDoc: AlbumSearchDocument = {
  id: "album-1",
  spotifyId: "sp-1",
  mbid: null,
  title: "OK Computer",
  primaryArtistName: "Radiohead",
  genreNames: ["Alternative Rock"],
  genreSlugs: ["alternative-rock"],
  releaseYear: 1997,
  coverUrl: null,
  popularityScore: 90,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MeiliService", () => {
  let calls: FakeCall[];

  beforeEach(() => {
    calls = [];
  });

  it("does no network I/O at construction (lazy infra)", () => {
    const fetchMock = stubFetch(calls);
    new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configureIndexes creates both indexes and applies their attribute settings", async () => {
    stubFetch(calls);
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    await service.configureIndexes();

    const created = calls.filter((c) => c.url.endsWith("/indexes"));
    expect(created).toHaveLength(2);
    expect(created.map((c) => (c.body as { uid: string }).uid).sort()).toEqual(
      [ALBUMS_INDEX, ARTISTS_INDEX].sort(),
    );

    const albumSettings = calls.find((c) =>
      c.url.endsWith(`/indexes/${ALBUMS_INDEX}/settings`),
    );
    expect(albumSettings?.method).toBe("PATCH");
    expect(albumSettings?.body).toEqual(ALBUMS_INDEX_SETTINGS);

    const artistSettings = calls.find((c) =>
      c.url.endsWith(`/indexes/${ARTISTS_INDEX}/settings`),
    );
    expect(artistSettings?.body).toEqual(ARTISTS_INDEX_SETTINGS);
  });

  it("indexAlbums POSTs documents to the albums index; an empty batch is a no-op", async () => {
    const fetchMock = stubFetch(calls);
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    await service.indexAlbums([]);
    expect(fetchMock).not.toHaveBeenCalled();

    await service.indexAlbums([albumDoc]);
    const call = calls.find((c) =>
      c.url.endsWith(`/indexes/${ALBUMS_INDEX}/documents`),
    );
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual([albumDoc]);
  });

  it("sends the Bearer master key when configured, and omits it when unset", async () => {
    stubFetch(calls);
    const withKey = new MeiliService(
      config({ MEILI_HOST: "http://meili:7700", MEILI_MASTER_KEY: "secret" }),
    );
    await withKey.indexAlbums([albumDoc]);
    expect(calls[0].headers.Authorization).toBe("Bearer secret");

    calls.length = 0;
    const noKey = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));
    await noKey.indexAlbums([albumDoc]);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("searchAlbums queries the albums index and returns hits + total", async () => {
    stubFetch(calls, () =>
      okResponse({ hits: [albumDoc], estimatedTotalHits: 1 }),
    );
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    const page = await service.searchAlbums("radiohead", { limit: 20, offset: 0 });

    const call = calls[0];
    expect(call.url).toBe(`http://meili:7700/indexes/${ALBUMS_INDEX}/search`);
    expect(call.body).toEqual({ q: "radiohead", limit: 20, offset: 0 });
    expect(page.hits).toEqual([albumDoc]);
    expect(page.estimatedTotalHits).toBe(1);
  });

  // judgment-day fix: Meilisearch's document-write endpoints are async — a 2xx
  // only means the write TASK was accepted, not that it succeeded. Logging the
  // `taskUid` gives an operator a way to cross-reference Meili's own task
  // history if a write silently fails Meili-side.
  it("logs the Meilisearch taskUid returned by a document-write call", async () => {
    stubFetch(calls, () => okResponse({ taskUid: 42, indexUid: ALBUMS_INDEX }));
    const debugSpy = vi
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => undefined);
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    await service.indexAlbums([albumDoc]);

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("42"),
    );

    debugSpy.mockRestore();
  });

  it("does not log a taskUid for responses that don't carry one (e.g. search)", async () => {
    stubFetch(calls, () => okResponse({ hits: [], estimatedTotalHits: 0 }));
    const debugSpy = vi
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => undefined);
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    await service.searchAlbums("x", { limit: 10, offset: 0 });

    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it("throws on a non-OK Meilisearch response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "boom",
        json: async () => ({}),
      })),
    );
    const service = new MeiliService(config({ MEILI_HOST: "http://meili:7700" }));

    await expect(service.indexAlbums([albumDoc])).rejects.toThrow(/500/);
  });
});
