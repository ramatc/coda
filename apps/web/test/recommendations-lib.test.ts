import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissRecommendation,
  fetchRecommendations,
  type Recommendation,
} from "../lib/recommendations";

const RECOMMENDATION: Recommendation = {
  id: "rec-1",
  score: 0.72,
  reason: { topGenre: "Rock", matchedArtist: true },
  album: {
    id: "album-1",
    title: "OK Computer",
    coverUrl: null,
    releaseYear: 1997,
    primaryArtistName: "Radiohead",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRecommendations", () => {
  it("returns the recommendations on a successful response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify([RECOMMENDATION]), { status: 200 }),
      );

    const items = await fetchRecommendations("test-token");

    expect(items).toEqual([RECOMMENDATION]);
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toContain("/recommendations");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("fails safe to an empty list on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    expect(await fetchRecommendations("test-token")).toEqual([]);
  });

  it("fails safe to an empty list on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchRecommendations(null)).toEqual([]);
  });
});

describe("dismissRecommendation", () => {
  it("POSTs to the dismiss endpoint with the encoded id and auth header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await dismissRecommendation("test-token", "rec-1");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/recommendations/rec-1/dismiss");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("throws on a non-OK response (so the island keeps the card)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );

    await expect(dismissRecommendation("test-token", "rec-1")).rejects.toThrow();
  });
});
