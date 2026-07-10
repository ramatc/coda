import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import { MusicBrainzClient } from "../src/catalog-import/musicbrainz.client.js";
import { MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS } from "../src/catalog-import/catalog-import.constants.js";

const CONFIG: Record<string, string> = {
  MUSICBRAINZ_USER_AGENT: "Coda/1.0 (https://coda.test)",
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

describe("MusicBrainzClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // Stub global fetch at the SDK boundary (no live network), mirroring
    // spotify.client.spec.
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeClient(): MusicBrainzClient {
    return new MusicBrainzClient(fakeConfig());
  }

  it("sends the configured descriptive User-Agent required by MusicBrainz policy", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "release-groups": [] }));

    await makeClient().lookupAlbum("OK Computer", "Radiohead");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/ws/2/release-group");
    expect(String(url)).toContain("fmt=json");
    expect(init.headers["user-agent"]).toBe("Coda/1.0 (https://coda.test)");
  });

  it("normalizes the top release-group into mbid, artist, and weighted genres", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [
          {
            id: "rg-mbid-1",
            title: "OK Computer",
            score: 100,
            "artist-credit": [
              { name: "Radiohead", artist: { id: "art-mbid-1", name: "Radiohead" } },
            ],
            // Deliberately out of weight order to prove the sort.
            genres: [
              { name: "Art Rock", count: 3 },
              { name: "Alternative Rock", count: 10 },
            ],
          },
          { id: "rg-mbid-2" },
        ],
      }),
    );

    const result = await makeClient().lookupAlbum("OK Computer", "Radiohead");

    expect(result).toEqual({
      mbid: "rg-mbid-1",
      artist: { mbid: "art-mbid-1", name: "Radiohead" },
      genres: [
        { slug: "alternative-rock", name: "Alternative Rock", weight: 10 },
        { slug: "art-rock", name: "Art Rock", weight: 3 },
      ],
    });
  });

  it("falls back to folksonomy tags when no curated genres are present, and tolerates a missing artist", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [
          { id: "rg", "artist-credit": [], tags: [{ name: "Indie", count: 2 }] },
        ],
      }),
    );

    const result = await makeClient().lookupAlbum("Some Album", null);

    expect(result?.artist).toBeNull();
    expect(result?.genres).toEqual([
      { slug: "indie", name: "Indie", weight: 2 },
    ]);
  });

  it("returns null (a benign no-match, not an error) when MusicBrainz has no candidate", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ count: 0, "release-groups": [] }),
    );

    expect(await makeClient().lookupAlbum("nope", "nobody")).toBeNull();
  });

  it("throws when the User-Agent is not configured (MusicBrainz requires one) and never hits the network", async () => {
    const client = new MusicBrainzClient(
      fakeConfig({ MUSICBRAINZ_USER_AGENT: "" }),
    );

    await expect(client.lookupAlbum("x", "y")).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-OK MusicBrainz response so BullMQ retry/backoff applies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503));

    await expect(makeClient().lookupAlbum("x", "y")).rejects.toThrow(/503/);
  });

  // Task 6.4: the rate limiter never exceeds 1 req/s under burst load, proven
  // with FAKE timers (no real waiting). The client-side gate is the layer that
  // is deterministically unit-testable; the BullMQ queue limiter is the
  // distributed second layer, exercised structurally by the worker spec.
  it("never issues more than one request per configured interval under burst load", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const callTimes: number[] = [];
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return jsonResponse({ "release-groups": [] });
    });

    const client = makeClient();
    // Fire five lookups concurrently — a burst that, ungated, would hit
    // MusicBrainz five times at once and get the client throttled/blocked.
    const burst = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.lookupAlbum(`Album ${i}`, `Artist ${i}`),
      ),
    );

    // Drive the fake clock forward far enough to release all five gated
    // requests, flushing microtasks between ticks (no real time elapses).
    await vi.advanceTimersByTimeAsync(5 * MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS);
    await burst;

    expect(callTimes).toHaveLength(5);
    // Every consecutive pair is spaced by at least the configured interval —
    // so no two requests ever land inside the same ≤1 req/s window.
    for (let i = 1; i < callTimes.length; i++) {
      expect(callTimes[i] - callTimes[i - 1]).toBeGreaterThanOrEqual(
        MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
      );
    }
    // Concretely deterministic spacing from t=0.
    expect(callTimes).toEqual([0, 1100, 2200, 3300, 4400]);
  });
});
