import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { SpotifyClient } from "../src/catalog-import/spotify.client.js";

const CONFIG: Record<string, string> = {
  SPOTIFY_CLIENT_ID: "test_client_id",
  SPOTIFY_CLIENT_SECRET: "test_client_secret",
};

function fakeConfig(overrides: Record<string, string> = {}): ConfigService {
  const map = { ...CONFIG, ...overrides };
  return { get: (key: string) => map[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

const TOKEN_BODY = {
  access_token: "access_token_abc",
  token_type: "Bearer",
  expires_in: 3600,
};

function albumPageBody(next: string | null) {
  return {
    albums: {
      total: 3,
      limit: 2,
      offset: 0,
      next,
      items: [
        {
          id: "spotify_alb_1",
          name: "OK Computer",
          release_date: "1997",
          release_date_precision: "year",
          images: [{ url: "https://cdn/cover1.jpg" }],
          total_tracks: 12,
          popularity: 88,
          artists: [
            {
              id: "spotify_art_1",
              name: "Radiohead",
              images: [{ url: "https://cdn/art1.jpg" }],
            },
          ],
        },
        {
          id: "spotify_alb_2",
          name: "In Rainbows",
          release_date: "2007-10-10",
          release_date_precision: "day",
          images: [],
          total_tracks: 10,
          popularity: 80,
          artists: [{ id: "spotify_art_1", name: "Radiohead" }],
        },
      ],
    },
  };
}

describe("SpotifyClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // Stub the global fetch at the SDK boundary (no live network), mirroring how
    // avatar.service.spec mocks the AWS SDK module.
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeClient(): SpotifyClient {
    return new SpotifyClient(fakeConfig());
  }

  it("obtains a client-credentials token with Basic auth, then calls the API with the Bearer token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN_BODY))
      .mockResolvedValueOnce(jsonResponse(albumPageBody(null)));

    const client = makeClient();
    const page = await client.getAlbumPage(0, 2);

    // First fetch = token endpoint, HTTP Basic base64(clientId:clientSecret).
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toContain("/api/token");
    expect(tokenInit.method).toBe("POST");
    const expectedBasic = Buffer.from(
      "test_client_id:test_client_secret",
    ).toString("base64");
    expect(tokenInit.headers.authorization).toBe(`Basic ${expectedBasic}`);

    // Second fetch = search endpoint, Bearer token from the grant.
    const [searchUrl, searchInit] = fetchMock.mock.calls[1];
    expect(String(searchUrl)).toContain("/v1/search");
    expect(String(searchUrl)).toContain("type=album");
    expect(searchInit.headers.authorization).toBe("Bearer access_token_abc");

    // Normalization: partial-precision date padded, cover/artist projected.
    expect(page.albums).toHaveLength(2);
    expect(page.albums[0]).toMatchObject({
      spotifyId: "spotify_alb_1",
      title: "OK Computer",
      releaseDate: "1997-01-01",
      coverUrl: "https://cdn/cover1.jpg",
      trackCount: 12,
      popularityScore: 88,
      primaryArtist: {
        spotifyId: "spotify_art_1",
        name: "Radiohead",
        imageUrl: "https://cdn/art1.jpg",
      },
    });
    expect(page.albums[1].releaseDate).toBe("2007-10-10");
    expect(page.albums[1].coverUrl).toBeNull();
    // `next` was null ⇒ final page.
    expect(page.nextOffset).toBeNull();
  });

  it("caches the access token across calls (single token request for two pages)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN_BODY))
      .mockResolvedValueOnce(
        jsonResponse(albumPageBody("https://api.spotify.com/v1/search?offset=2")),
      )
      .mockResolvedValueOnce(jsonResponse(albumPageBody(null)));

    const client = makeClient();
    const first = await client.getAlbumPage(0, 2);
    const second = await client.getAlbumPage(2, 2);

    // 1 token request + 2 search requests = 3 total (token not re-fetched).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/token"),
    );
    expect(tokenCalls).toHaveLength(1);
    // A non-null `next` yields the next offset for the pager to continue.
    expect(first.nextOffset).toBe(2);
    expect(second.nextOffset).toBeNull();
  });

  it("throws when Spotify credentials are missing", async () => {
    const client = new SpotifyClient(fakeConfig({ SPOTIFY_CLIENT_ID: "" }));
    await expect(client.getAlbumPage(0, 2)).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-OK Spotify API response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TOKEN_BODY))
      .mockResolvedValueOnce(jsonResponse({}, false, 429));

    const client = makeClient();
    await expect(client.getAlbumPage(0, 2)).rejects.toThrow(/429/);
  });
});
