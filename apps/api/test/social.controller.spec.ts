import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialController } from "../src/social/social.controller.js";
import type { SocialService } from "../src/social/social.service.js";

/**
 * Unit test for {@link SocialController}: it is a thin pass-through to
 * {@link SocialService} (the domain logic is covered in `social.service.spec.ts`).
 * Proves each route forwards the `ClerkGuard`-verified `@CurrentUser("sub")` and
 * the `:username` path param exactly as received, and returns the service result.
 */
describe("SocialController", () => {
  let follow: ReturnType<typeof vi.fn>;
  let unfollow: ReturnType<typeof vi.fn>;
  let getSocialStats: ReturnType<typeof vi.fn>;
  let getFeed: ReturnType<typeof vi.fn>;
  let controller: SocialController;

  beforeEach(() => {
    follow = vi.fn().mockResolvedValue({ following: true });
    unfollow = vi.fn().mockResolvedValue({ following: false });
    getSocialStats = vi.fn().mockResolvedValue({
      followerCount: 3,
      followingCount: 5,
      isFollowing: true,
    });
    getFeed = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const service = {
      follow,
      unfollow,
      getSocialStats,
      getFeed,
    } as unknown as SocialService;
    controller = new SocialController(service);
  });

  it("POST follow forwards caller id and username, returning the service result", async () => {
    const result = await controller.follow("clerk_1", "bob");

    expect(follow).toHaveBeenCalledWith("clerk_1", "bob");
    expect(result).toEqual({ following: true });
  });

  it("DELETE follow forwards caller id and username, returning the service result", async () => {
    const result = await controller.unfollow("clerk_1", "bob");

    expect(unfollow).toHaveBeenCalledWith("clerk_1", "bob");
    expect(result).toEqual({ following: false });
  });

  it("GET social forwards caller id and username, returning the stats", async () => {
    const result = await controller.getSocialStats("clerk_1", "bob");

    expect(getSocialStats).toHaveBeenCalledWith("clerk_1", "bob");
    expect(result).toEqual({
      followerCount: 3,
      followingCount: 5,
      isFollowing: true,
    });
  });

  it("GET feed forwards caller id plus cursor and limit query params", async () => {
    const page = {
      items: [{ id: "e1" }],
      nextCursor: "e1",
    };
    getFeed.mockResolvedValueOnce(page);

    const result = await controller.getFeed("clerk_1", "cursor-abc", "10");

    expect(getFeed).toHaveBeenCalledWith("clerk_1", {
      cursor: "cursor-abc",
      limit: "10",
    });
    expect(result).toBe(page);
  });

  it("GET feed forwards undefined cursor/limit when the query params are absent", async () => {
    await controller.getFeed("clerk_1");

    expect(getFeed).toHaveBeenCalledWith("clerk_1", {
      cursor: undefined,
      limit: undefined,
    });
  });
});
