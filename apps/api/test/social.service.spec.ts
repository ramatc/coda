import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { SocialService } from "../src/social/social.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CALLER_CLERK = "clerk_caller";
const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_CLERK = "clerk_target";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_USERNAME = "target";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

interface FollowRow {
  followerId: string;
  followingId: string;
}

/**
 * In-memory Prisma stand-in honouring the exact queries {@link SocialService}
 * issues for the follow graph: `user.findUnique` by clerk id, `profile.findUnique`
 * by username, and `follow.upsert` / `follow.deleteMany` / `follow.count`. Proves
 * the follow/unfollow/stats logic deterministically without a live Postgres
 * (the project's no-docker sandbox convention, mirroring activity.service.spec).
 */
function createFakePrisma() {
  // clerkUserId -> local user id
  const usersByClerk = new Map<string, string>();
  // username (lowercased) -> local user id
  const usersByUsername = new Map<string, string>();
  const follows: FollowRow[] = [];

  function findFollowIndex(followerId: string, followingId: string): number {
    return follows.findIndex(
      (f) => f.followerId === followerId && f.followingId === followingId,
    );
  }

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = usersByClerk.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    profile: {
      async findUnique(args: {
        where: { username: string };
      }): Promise<{ userId: string } | null> {
        const userId = usersByUsername.get(args.where.username);
        return userId ? { userId } : null;
      },
    },
    follow: {
      async upsert(args: {
        where: { followerId_followingId: { followerId: string; followingId: string } };
        create: FollowRow;
      }): Promise<FollowRow> {
        const { followerId, followingId } = args.where.followerId_followingId;
        const idx = findFollowIndex(followerId, followingId);
        if (idx === -1) {
          follows.push({ ...args.create });
        }
        return { followerId, followingId };
      },
      async deleteMany(args: {
        where: { followerId: string; followingId: string };
      }): Promise<{ count: number }> {
        const { followerId, followingId } = args.where;
        const idx = findFollowIndex(followerId, followingId);
        if (idx === -1) return { count: 0 };
        follows.splice(idx, 1);
        return { count: 1 };
      },
      async count(args: {
        where: { followerId?: string; followingId?: string };
      }): Promise<number> {
        return follows.filter((f) => {
          if (args.where.followerId !== undefined && f.followerId !== args.where.followerId) {
            return false;
          }
          if (args.where.followingId !== undefined && f.followingId !== args.where.followingId) {
            return false;
          }
          return true;
        }).length;
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    usersByClerk,
    usersByUsername,
    follows,
  };
}

describe("SocialService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: SocialService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new SocialService(fake.prisma);
    fake.usersByClerk.set(CALLER_CLERK, CALLER_ID);
    fake.usersByClerk.set(TARGET_CLERK, TARGET_ID);
    fake.usersByUsername.set(TARGET_USERNAME, TARGET_ID);
  });

  describe("follow", () => {
    it("creates a Follow row and reports following:true", async () => {
      const result = await service.follow(CALLER_CLERK, TARGET_USERNAME);

      expect(result).toEqual({ following: true });
      expect(fake.follows).toHaveLength(1);
      expect(fake.follows[0]).toEqual({
        followerId: CALLER_ID,
        followingId: TARGET_ID,
      });
    });

    it("rejects a self-follow with a 400 and creates no row", async () => {
      fake.usersByUsername.set("me", CALLER_ID);

      await expect(service.follow(CALLER_CLERK, "me")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fake.follows).toHaveLength(0);
    });

    it("is idempotent: a duplicate follow returns following:true without a second row", async () => {
      await service.follow(CALLER_CLERK, TARGET_USERNAME);
      const again = await service.follow(CALLER_CLERK, TARGET_USERNAME);

      expect(again).toEqual({ following: true });
      expect(fake.follows).toHaveLength(1);
    });

    it("rejects following an unknown / unsynced target with a 404", async () => {
      await expect(
        service.follow(CALLER_CLERK, "ghost"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.follows).toHaveLength(0);
    });

    it("rejects an unsynced caller with a 404", async () => {
      await expect(
        service.follow("unsynced_clerk_id", TARGET_USERNAME),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.follows).toHaveLength(0);
    });
  });

  describe("unfollow", () => {
    it("deletes the Follow row and reports following:false", async () => {
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });

      const result = await service.unfollow(CALLER_CLERK, TARGET_USERNAME);

      expect(result).toEqual({ following: false });
      expect(fake.follows).toHaveLength(0);
    });

    it("is a no-op when not currently following: reports following:false, no error", async () => {
      const result = await service.unfollow(CALLER_CLERK, TARGET_USERNAME);

      expect(result).toEqual({ following: false });
      expect(fake.follows).toHaveLength(0);
    });

    it("leaves an unrelated follow row untouched", async () => {
      fake.usersByUsername.set("third", THIRD_ID);
      fake.follows.push({ followerId: CALLER_ID, followingId: THIRD_ID });

      await service.unfollow(CALLER_CLERK, TARGET_USERNAME);

      expect(fake.follows).toEqual([
        { followerId: CALLER_ID, followingId: THIRD_ID },
      ]);
    });

    it("rejects unfollowing an unknown / unsynced target with a 404", async () => {
      await expect(
        service.unfollow(CALLER_CLERK, "ghost"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.follows).toHaveLength(0);
    });

    it("rejects an unsynced caller with a 404", async () => {
      await expect(
        service.unfollow("unsynced_clerk_id", TARGET_USERNAME),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.follows).toHaveLength(0);
    });
  });

  describe("getSocialStats", () => {
    it("counts followers and following from live rows and reports isFollowing when the caller follows the target", async () => {
      // Target is followed by CALLER and THIRD (2 followers); target follows one
      // user (THIRD) => followingCount 1.
      fake.usersByUsername.set("third", THIRD_ID);
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });
      fake.follows.push({ followerId: THIRD_ID, followingId: TARGET_ID });
      fake.follows.push({ followerId: TARGET_ID, followingId: THIRD_ID });

      const stats = await service.getSocialStats(CALLER_CLERK, TARGET_USERNAME);

      expect(stats).toEqual({
        followerCount: 2,
        followingCount: 1,
        isFollowing: true,
      });
    });

    it("reports zero counts and isFollowing:false for a user with no follows either direction", async () => {
      const stats = await service.getSocialStats(CALLER_CLERK, TARGET_USERNAME);

      expect(stats).toEqual({
        followerCount: 0,
        followingCount: 0,
        isFollowing: false,
      });
    });

    it("reports isFollowing:false when the caller does not follow the target", async () => {
      // Someone else follows the target, but the caller does not.
      fake.usersByUsername.set("third", THIRD_ID);
      fake.follows.push({ followerId: THIRD_ID, followingId: TARGET_ID });

      const stats = await service.getSocialStats(CALLER_CLERK, TARGET_USERNAME);

      expect(stats).toEqual({
        followerCount: 1,
        followingCount: 0,
        isFollowing: false,
      });
    });

    it("degrades to isFollowing:false for an unsynced caller (counts still resolve)", async () => {
      fake.usersByClerk.delete(CALLER_CLERK); // caller has no local row yet
      fake.usersByUsername.set("third", THIRD_ID);
      fake.follows.push({ followerId: THIRD_ID, followingId: TARGET_ID });

      const stats = await service.getSocialStats(CALLER_CLERK, TARGET_USERNAME);

      expect(stats).toEqual({
        followerCount: 1,
        followingCount: 0,
        isFollowing: false,
      });
    });

    it("throws 404 for an unknown target username", async () => {
      await expect(
        service.getSocialStats(CALLER_CLERK, "ghost"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
