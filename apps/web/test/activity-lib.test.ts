import { afterEach, describe, expect, it, vi } from "vitest";
import { INVALID_CURSOR, fetchActivity } from "../lib/activity";
import type { ActivityPage } from "../lib/activity";

/**
 * Unit tests for the activity lib's `fetchActivity` helper, mirroring
 * `albums-lib.test.ts`'s `fetch`-stubbing style: the success path, cursor
 * propagation into the request URL, and the throw-on-error posture (the feed is
 * the page's primary content, so a transport failure surfaces rather than
 * silently rendering an empty stream).
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE: ActivityPage = {
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
    },
  ],
  nextCursor: null,
};

describe("fetchActivity", () => {
  it("returns the parsed page on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => PAGE }),
    );
    expect(await fetchActivity("t")).toEqual(PAGE);
  });

  it("passes the cursor as a query param when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => PAGE });
    vi.stubGlobal("fetch", fetchMock);

    await fetchActivity("t", "cursor-123");

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/me/activity");
    expect(calledUrl).toContain("cursor=cursor-123");
  });

  it("omits the cursor param when none is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => PAGE });
    vi.stubGlobal("fetch", fetchMock);

    await fetchActivity("t");

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain("cursor=");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await expect(fetchActivity("t")).rejects.toThrow(
      "Failed to load activity (500)",
    );
  });

  it("returns INVALID_CURSOR on a 400 instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    expect(await fetchActivity("t", "not-a-uuid")).toBe(INVALID_CURSOR);
  });
});
