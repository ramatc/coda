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
  let controller: SocialController;

  beforeEach(() => {
    follow = vi.fn().mockResolvedValue({ following: true });
    unfollow = vi.fn().mockResolvedValue({ following: false });
    getSocialStats = vi.fn().mockResolvedValue({
      followerCount: 3,
      followingCount: 5,
      isFollowing: true,
    });
    const service = {
      follow,
      unfollow,
      getSocialStats,
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
});
