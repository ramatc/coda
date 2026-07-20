import { afterEach, describe, expect, it, vi } from "vitest";
import { INVALID_CURSOR, fetchFeed } from "../lib/feed";
import type { FeedPage } from "../lib/feed";

/**
 * Unit tests for the feed lib's `fetchFeed` helper, mirroring `activity-lib.test.ts`:
 * the success path (including the `actor` field unique to the followed-activity
 * feed), cursor propagation into the request URL, the `INVALID_CURSOR` sentinel on
 * a 400 (malformed cursor), and the throw-on-error posture (the feed is the page's
 * primary content, so a transport failure surfaces rather than silently rendering
 * an empty stream).
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE: FeedPage = {
  items: [
    {
      id: "ev-1",
      type: "LISTEN",
      occurredAt: "2026-07-01T10:00:00.000Z",
      album: {
        id: "album-1",
        title: "OK Computer",
        coverUrl: null,
        primaryArtistName: "Radiohead",
      },
      score: null,
      reviewBody: null,
      actor: {
        username: "thom",
        displayName: "Thom Yorke",
        avatarUrl: null,
      },
    },
  ],
  nextCursor: null,
};

describe("fetchFeed", () => {
  it("returns the parsed page (with actor) on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => PAGE }),
    );
    expect(await fetchFeed("t")).toEqual(PAGE);
  });

  it("requests the /feed endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => PAGE });
    vi.stubGlobal("fetch", fetchMock);

    await fetchFeed("t");

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/feed");
  });

  it("passes the cursor as a query param when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => PAGE });
    vi.stubGlobal("fetch", fetchMock);

    await fetchFeed("t", "cursor-123");

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("cursor=cursor-123");
  });

  it("omits the cursor param when none is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => PAGE });
    vi.stubGlobal("fetch", fetchMock);

    await fetchFeed("t");

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain("cursor=");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(fetchFeed("t")).rejects.toThrow("Failed to load feed (500)");
  });

  it("returns INVALID_CURSOR on a 400 instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    expect(await fetchFeed("t", "not-a-uuid")).toBe(INVALID_CURSOR);
  });
});
