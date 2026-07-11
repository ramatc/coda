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
          {
            id: "rg",
            score: 100,
            "artist-credit": [],
            tags: [{ name: "Indie", count: 2 }],
          },
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

  // judgment-day issue #2: an unconditionally-accepted top candidate can be a
  // low-confidence false positive for an ambiguous/generic title.
  it("rejects a top candidate below the minimum relevance score, treating it as no-match", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [{ id: "rg-low-confidence", score: 40 }],
      }),
    );

    expect(await makeClient().lookupAlbum("Greatest Hits", "Various")).toBeNull();
  });

  // judgment-day issue #4, round 2: a candidate missing `score` entirely must
  // not silently bypass the confidence threshold by defaulting to accept.
  it("rejects a top candidate with a missing score field, treating it as no-match", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [{ id: "rg-no-score", "artist-credit": [] }],
      }),
    );

    expect(
      await makeClient().lookupAlbum("Ambiguous Title", "Some Artist"),
    ).toBeNull();
  });

  it("accepts a top candidate exactly at the minimum score threshold", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [{ id: "rg-borderline", score: 80, "artist-credit": [] }],
      }),
    );

    const result = await makeClient().lookupAlbum("OK Computer", "Radiohead");

    expect(result?.mbid).toBe("rg-borderline");
  });

  // judgment-day issue #7: a malformed response shape must not escape as a
  // plain TypeError — the per-item error isolation only recognizes Prisma
  // errors, so an uncaught shape error would exhaust BullMQ's retries on a
  // deterministically-failing job instead of being skipped benignly.
  it("treats a malformed artist-credit shape as a benign no-match instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [
          { id: "rg-malformed", score: 100, "artist-credit": "not-an-array" },
        ],
      }),
    );

    await expect(
      makeClient().lookupAlbum("Weird Response", "Nobody"),
    ).resolves.toBeNull();
  });

  // judgment-day issue #8: two raw tags collapsing to the same slug must not
  // consume two of the limited MAX_GENRES slots, and the higher-weight entry
  // must win rather than being silently overwritten by a later duplicate.
  it("dedupes genres by slug (keeping the max weight) before slicing to the genre cap", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "release-groups": [
          {
            id: "rg-dupe-genres",
            score: 100,
            "artist-credit": [],
            genres: [
              { name: "Art Rock", count: 3 },
              { name: "art-rock", count: 9 },
            ],
          },
        ],
      }),
    );

    const result = await makeClient().lookupAlbum("Some Album", "Some Artist");

    expect(result?.genres).toEqual([
      { slug: "art-rock", name: "art-rock", weight: 9 },
    ]);
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

  // judgment-day issue #10: the burst test above uses a near-instant mocked
  // `fetch`, so it can't distinguish "gate advances at request ACQUISITION"
  // (the documented, correct design) from "gate advances at request
  // COMPLETION" (a plausible incorrect alternative that would still pass that
  // specific test, since near-instant requests make the two indistinguishable).
  // Here each mocked `fetch` takes several fake-timer ticks to resolve — if the
  // gate incorrectly advanced on completion, request spacing would include the
  // slow response time; the correct acquisition-based gate keeps spacing at
  // exactly the configured interval regardless.
  it("spaces requests from ACQUISITION time, not completion time, even when a request is slow to resolve", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const RESPONSE_DELAY_MS = 3 * MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS;
    const callTimes: number[] = [];
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      // Slow response: several fake-timer ticks pass before this particular
      // request resolves.
      await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
      return jsonResponse({ "release-groups": [] });
    });

    const client = makeClient();
    const calls = Promise.all([
      client.lookupAlbum("Album 1", "Artist 1"),
      client.lookupAlbum("Album 2", "Artist 2"),
      client.lookupAlbum("Album 3", "Artist 3"),
    ]);

    await vi.advanceTimersByTimeAsync(3 * (RESPONSE_DELAY_MS + MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS));
    await calls;

    expect(callTimes).toHaveLength(3);
    // Spaced by exactly the configured interval — NOT interval + the previous
    // request's RESPONSE_DELAY_MS, which is what a completion-based gate would
    // produce instead.
    expect(callTimes).toEqual([
      0,
      MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
      2 * MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
    ]);
  });
});
