import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSocialStats,
  followUser,
  unfollowUser,
  type SocialStats,
} from "../lib/social";

const STATS: SocialStats = {
  followerCount: 3,
  followingCount: 5,
  isFollowing: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchSocialStats", () => {
  it("returns the stats on a successful response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(STATS), { status: 200 }));

    const result = await fetchSocialStats("test-token", "ada");

    expect(result).toEqual(STATS);
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toContain("/users/ada/social");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("encodes the username in the URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(STATS), { status: 200 }));

    await fetchSocialStats("test-token", "ada lovelace");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(encodeURIComponent("ada lovelace"));
  });

  it("falls back to empty stats on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    expect(await fetchSocialStats("test-token", "ada")).toEqual({
      followerCount: 0,
      followingCount: 0,
      isFollowing: false,
    });
  });

  it("falls back to empty stats on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchSocialStats(null, "ada")).toEqual({
      followerCount: 0,
      followingCount: 0,
      isFollowing: false,
    });
  });
});

describe("followUser", () => {
  it("POSTs to the follow endpoint with the encoded username and auth header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await followUser("test-token", "ada");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/users/ada/follow");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("encodes the username in the URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await followUser("test-token", "ada lovelace");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(encodeURIComponent("ada lovelace"));
  });

  it("throws on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );

    await expect(followUser("test-token", "ada")).rejects.toThrow();
  });
});

describe("unfollowUser", () => {
  it("DELETEs to the follow endpoint with the encoded username and auth header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await unfollowUser("test-token", "ada");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/users/ada/follow");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("DELETE");
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("encodes the username in the URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await unfollowUser("test-token", "ada lovelace");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(encodeURIComponent("ada lovelace"));
  });

  it("throws on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404 }),
    );

    await expect(unfollowUser("test-token", "ada")).rejects.toThrow();
  });
});
