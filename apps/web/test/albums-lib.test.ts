import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALBUM_NOT_FOUND,
  deleteListen,
  deleteRating,
  fetchAlbumDetail,
  markListened,
  rateAlbum,
  writeReview,
} from "../lib/albums";
import type { AlbumDetail } from "../lib/albums";

/**
 * Unit tests for the albums lib's fetch helpers, mirroring `search-lib.test.ts`'s
 * `fetch`-stubbing style: `fetchAlbumDetail`'s 404 sentinel + success paths, and
 * each mutation helper's success/error paths — including the 404-specific
 * "account still syncing" messaging (judgment-day PR9 round 2, finding #2).
 *
 * The "account still syncing" message is keyed off the API's stable
 * `code: "ACCOUNT_NOT_SYNCED"` field, NOT off message presence — a `message` is
 * always present on this exact 404, so a precedence based on message content
 * would never actually show the friendly copy (judgment-day PR9 round 3,
 * finding #1).
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALBUM: AlbumDetail = {
  id: "album-1",
  title: "OK Computer",
  coverUrl: null,
  releaseDate: "1997-06-16",
  releaseYear: 1997,
  trackCount: 12,
  primaryArtist: { id: "artist-1", name: "Radiohead" },
  genres: [],
  tracks: [],
  aggregateRating: { average: 9, count: 1 },
  viewer: { listened: false, listenId: null, score: null, review: null },
};

describe("fetchAlbumDetail", () => {
  it("returns ALBUM_NOT_FOUND on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    expect(await fetchAlbumDetail("t", "album-1")).toBe(ALBUM_NOT_FOUND);
  });

  it("returns the parsed album on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ALBUM,
      }),
    );
    expect(await fetchAlbumDetail("t", "album-1")).toEqual(ALBUM);
  });

  it("throws for a non-404 non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500, ok: false }),
    );
    await expect(fetchAlbumDetail("t", "album-1")).rejects.toThrow(
      "Failed to load album (500)",
    );
  });
});

describe("markListened", () => {
  it("resolves on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(markListened("t", "album-1")).resolves.toBeUndefined();
  });

  it("surfaces the 404 account-syncing message when the API reports the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          message: "No user found for the current session",
          code: "ACCOUNT_NOT_SYNCED",
        }),
      }),
    );
    await expect(markListened("t", "album-1")).rejects.toThrow(
      "Your account is still syncing — try again in a moment.",
    );
  });

  it("shows the server's raw message on a 404 WITHOUT the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Listen not found" }),
      }),
    );
    await expect(markListened("t", "album-1")).rejects.toThrow(
      "Listen not found",
    );
  });

  it("falls back to the generic message on a 404 with no message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    );
    await expect(markListened("t", "album-1")).rejects.toThrow(
      "Could not mark this album as listened.",
    );
  });

  it("throws a generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(markListened("t", "album-1")).rejects.toThrow(
      "Could not mark this album as listened.",
    );
  });
});

describe("deleteListen", () => {
  it("resolves on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(deleteListen("t", "listen-1")).resolves.toBeUndefined();
  });

  it("surfaces the 404 account-syncing message when the API reports the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          message: "No user found for the current session",
          code: "ACCOUNT_NOT_SYNCED",
        }),
      }),
    );
    await expect(deleteListen("t", "listen-1")).rejects.toThrow(
      "Your account is still syncing — try again in a moment.",
    );
  });

  it("shows the server's raw message on a 404 WITHOUT the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Listen not found" }),
      }),
    );
    await expect(deleteListen("t", "listen-1")).rejects.toThrow("Listen not found");
  });

  it("falls back to the generic message on a 404 with no message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    await expect(deleteListen("t", "listen-1")).rejects.toThrow(
      "Could not remove this listen.",
    );
  });

  it("throws a generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(deleteListen("t", "listen-1")).rejects.toThrow(
      "Could not remove this listen.",
    );
  });
});

describe("rateAlbum", () => {
  it("resolves on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(rateAlbum("t", "album-1", 8)).resolves.toBeUndefined();
  });

  it("surfaces the 404 account-syncing message when the API reports the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          message: "No user found for the current session",
          code: "ACCOUNT_NOT_SYNCED",
        }),
      }),
    );
    await expect(rateAlbum("t", "album-1", 8)).rejects.toThrow(
      "Your account is still syncing — try again in a moment.",
    );
  });

  it("shows the server's raw message on a 404 WITHOUT the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Unknown album: album-1" }),
      }),
    );
    await expect(rateAlbum("t", "album-1", 8)).rejects.toThrow(
      "Unknown album: album-1",
    );
  });

  it("falls back to the generic message on a 404 with no message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    await expect(rateAlbum("t", "album-1", 8)).rejects.toThrow(
      "Could not save your rating.",
    );
  });

  it("throws a generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(rateAlbum("t", "album-1", 8)).rejects.toThrow(
      "Could not save your rating.",
    );
  });
});

describe("deleteRating", () => {
  it("resolves on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(deleteRating("t", "album-1")).resolves.toBeUndefined();
  });

  it("surfaces the 404 account-syncing message when the API reports the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          message: "No user found for the current session",
          code: "ACCOUNT_NOT_SYNCED",
        }),
      }),
    );
    await expect(deleteRating("t", "album-1")).rejects.toThrow(
      "Your account is still syncing — try again in a moment.",
    );
  });

  it("shows the server's raw message on a 404 WITHOUT the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Rating not found" }),
      }),
    );
    await expect(deleteRating("t", "album-1")).rejects.toThrow("Rating not found");
  });

  it("falls back to the generic message on a 404 with no message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    await expect(deleteRating("t", "album-1")).rejects.toThrow(
      "Could not remove your rating.",
    );
  });

  it("throws a generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(deleteRating("t", "album-1")).rejects.toThrow(
      "Could not remove your rating.",
    );
  });
});

describe("writeReview", () => {
  it("resolves on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await expect(writeReview("t", "album-1", "Great record.")).resolves.toBeUndefined();
  });

  it("throws a specific message on a 400 (unrated album)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(writeReview("t", "album-1", "Great record.")).rejects.toThrow(
      "Rate this album before writing a review.",
    );
  });

  it("surfaces the 404 account-syncing message when the API reports the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          message: "No user found for the current session",
          code: "ACCOUNT_NOT_SYNCED",
        }),
      }),
    );
    await expect(writeReview("t", "album-1", "Great record.")).rejects.toThrow(
      "Your account is still syncing — try again in a moment.",
    );
  });

  it("shows the server's raw message on a 404 WITHOUT the ACCOUNT_NOT_SYNCED code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ message: "Unknown album: album-1" }),
      }),
    );
    await expect(writeReview("t", "album-1", "Great record.")).rejects.toThrow(
      "Unknown album: album-1",
    );
  });

  it("falls back to the generic message on a 404 with no message and no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    await expect(writeReview("t", "album-1", "Great record.")).rejects.toThrow(
      "Could not save your review.",
    );
  });

  it("throws a generic message for other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(writeReview("t", "album-1", "Great record.")).rejects.toThrow(
      "Could not save your review.",
    );
  });
});
