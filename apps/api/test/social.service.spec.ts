import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ActivityType } from "@coda/db";
import { SocialService } from "../src/social/social.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CALLER_CLERK = "clerk_caller";
const CALLER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_CLERK = "clerk_target";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_USERNAME = "target";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
const FOURTH_ID = "44444444-4444-4444-8444-444444444444";

interface FollowRow {
  followerId: string;
  followingId: string;
}

/** An activity-event row in the shape {@link SocialService.getFeed} selects it. */
interface FeedEventRow {
  id: string;
  userId: string;
  type: ActivityType;
  occurredAt: Date;
  payload: unknown;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtist: { name: string };
  };
  review: { body: string } | null;
}

interface ActorProfile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

const ALBUM = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "OK Computer",
  coverUrl: "https://cdn.coda.test/ok.jpg",
  primaryArtist: { name: "Radiohead" },
};

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
  // Fan-in feed source: activity events keyed by their owning user id, plus the
  // actor profile the feed nests per event.
  const activityEvents: FeedEventRow[] = [];
  const profilesByUserId = new Map<string, ActorProfile>();

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
      async findMany(args: {
        where: { followerId: string };
      }): Promise<{ followingId: string }[]> {
        return follows
          .filter((f) => f.followerId === args.where.followerId)
          .map((f) => ({ followingId: f.followingId }));
      },
    },
    activityEvent: {
      // Mirrors the `activityEvent.findMany` the feed issues: a `userId IN (...)`
      // fan-in filter, `[{ occurredAt desc }, { id desc }]` ordering, `take`, and
      // optional `cursor`+`skip`. The cursor semantics copy activity.service.spec:
      // a well-formed cursor id that matches no row resolves to an empty slice
      // (real Prisma's scalar anchor comparison is NULL against every row), not a
      // silent fallback to "no cursor". Each row nests its actor profile, matching
      // the `user: { select: { profile: {...} } }` shape the service selects.
      async findMany(args: {
        where: { userId: { in: string[] } };
        take: number;
        cursor?: { id: string };
        skip?: number;
      }): Promise<
        (Omit<FeedEventRow, "userId"> & {
          user: { profile: ActorProfile | null };
        })[]
      > {
        const allowed = new Set(args.where.userId.in);
        let rows = activityEvents
          .filter((e) => allowed.has(e.userId))
          .sort((a, b) => {
            const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
            if (byTime !== 0) return byTime;
            return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
          });
        if (args.cursor) {
          const idx = rows.findIndex((r) => r.id === args.cursor?.id);
          rows = idx >= 0 ? rows.slice(idx + (args.skip ?? 0)) : [];
        }
        return rows.slice(0, args.take).map((e) => ({
          id: e.id,
          type: e.type,
          occurredAt: e.occurredAt,
          payload: e.payload,
          album: e.album,
          review: e.review,
          user: { profile: profilesByUserId.get(e.userId) ?? null },
        }));
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    usersByClerk,
    usersByUsername,
    follows,
    activityEvents,
    profilesByUserId,
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

  describe("getFeed", () => {
    // B (target), C (third), D (fourth) each have an actor profile the feed nests.
    beforeEach(() => {
      fake.profilesByUserId.set(TARGET_ID, {
        username: "target",
        displayName: "Target User",
        avatarUrl: "https://cdn.coda.test/target.jpg",
      });
      fake.profilesByUserId.set(THIRD_ID, {
        username: "third",
        displayName: "Third User",
        avatarUrl: null,
      });
      fake.profilesByUserId.set(FOURTH_ID, {
        username: "fourth",
        displayName: "Fourth User",
        avatarUrl: null,
      });
    });

    function pushEvent(
      overrides: Partial<FeedEventRow> &
        Pick<FeedEventRow, "id" | "userId" | "type" | "occurredAt">,
    ): void {
      fake.activityEvents.push({
        payload: null,
        album: ALBUM,
        review: null,
        ...overrides,
      });
    }

    it("returns only followed users' events, every activity type, most recent first, each with its actor", async () => {
      // A follows B and C, but NOT D.
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });
      fake.follows.push({ followerId: CALLER_ID, followingId: THIRD_ID });

      const bListen = "e1111111-1111-4111-8111-111111111111";
      const bRating = "e2222222-2222-4222-8222-222222222222";
      const cReview = "e3333333-3333-4333-8333-333333333333";
      const dRating = "e4444444-4444-4444-8444-444444444444";

      pushEvent({
        id: bListen,
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: new Date("2026-07-01T10:00:00.000Z"),
      });
      pushEvent({
        id: bRating,
        userId: TARGET_ID,
        type: ActivityType.RATING,
        occurredAt: new Date("2026-07-03T10:00:00.000Z"),
        payload: { score: 8 },
      });
      pushEvent({
        id: cReview,
        userId: THIRD_ID,
        type: ActivityType.REVIEW,
        occurredAt: new Date("2026-07-02T10:00:00.000Z"),
        review: { body: "A masterpiece." },
      });
      // D is NOT followed and its event is the most recent — must be excluded.
      pushEvent({
        id: dRating,
        userId: FOURTH_ID,
        type: ActivityType.RATING,
        occurredAt: new Date("2026-07-05T10:00:00.000Z"),
        payload: { score: 10 },
      });

      const page = await service.getFeed(CALLER_CLERK);

      // Only B and C events, strict recency order, D excluded despite being newer.
      expect(page.items.map((i) => i.id)).toEqual([bRating, cReview, bListen]);
      expect(page.items.map((i) => i.type)).toEqual([
        ActivityType.RATING,
        ActivityType.REVIEW,
        ActivityType.LISTEN,
      ]);
      // Payload-derived score and review body render like the personal stream.
      expect(page.items[0].score).toBe(8);
      expect(page.items[1].reviewBody).toBe("A masterpiece.");
      expect(page.items[2].score).toBeNull();
      // Each item carries its actor profile.
      expect(page.items[0].actor).toEqual({
        username: "target",
        displayName: "Target User",
        avatarUrl: "https://cdn.coda.test/target.jpg",
      });
      expect(page.items[1].actor).toEqual({
        username: "third",
        displayName: "Third User",
        avatarUrl: null,
      });
      expect(page.items[0].album.primaryArtistName).toBe("Radiohead");
      expect(page.nextCursor).toBeNull();
    });

    it("does not require reciprocity: a followed user's events appear even if they do not follow back", async () => {
      // A follows B; B does NOT follow A.
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });
      pushEvent({
        id: "e5555555-5555-4555-8555-555555555555",
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: new Date("2026-07-01T10:00:00.000Z"),
      });

      const page = await service.getFeed(CALLER_CLERK);

      expect(page.items).toHaveLength(1);
      expect(page.items[0].actor.username).toBe("target");
    });

    it("returns an empty page when the caller follows no one", async () => {
      // Events exist, but the caller follows nobody, so none are visible.
      pushEvent({
        id: "e6666666-6666-4666-8666-666666666666",
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: new Date("2026-07-01T10:00:00.000Z"),
      });

      const page = await service.getFeed(CALLER_CLERK);

      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("returns an empty page when followed users have no activity", async () => {
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });

      const page = await service.getFeed(CALLER_CLERK);

      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("degrades to an empty page for an unsynced caller (no local User row)", async () => {
      fake.usersByClerk.delete(CALLER_CLERK);
      // Even with a follow row and events present, an unsynced caller sees nothing.
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });
      pushEvent({
        id: "e7777777-7777-4777-8777-777777777777",
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: new Date("2026-07-01T10:00:00.000Z"),
      });

      const page = await service.getFeed(CALLER_CLERK);

      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it("cursor-paginates with an id-desc tie-break when events share the same occurredAt", async () => {
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });
      const SAME_TIME = new Date("2026-07-04T10:00:00.000Z");
      const idHigh = "eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"; // sorts first (id desc)
      const idLow = "eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"; // tied on time, lower id
      const idOlder = "eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0"; // strictly older

      pushEvent({
        id: idLow,
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: SAME_TIME,
      });
      pushEvent({
        id: idHigh,
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: SAME_TIME,
      });
      pushEvent({
        id: idOlder,
        userId: TARGET_ID,
        type: ActivityType.LISTEN,
        occurredAt: new Date("2026-07-03T10:00:00.000Z"),
      });

      const first = await service.getFeed(CALLER_CLERK, { limit: 1 });
      expect(first.items.map((i) => i.id)).toEqual([idHigh]);
      expect(first.nextCursor).toBe(idHigh);

      const second = await service.getFeed(CALLER_CLERK, {
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((i) => i.id)).toEqual([idLow]);
      expect(second.nextCursor).toBe(idLow);

      const third = await service.getFeed(CALLER_CLERK, {
        limit: 1,
        cursor: second.nextCursor ?? undefined,
      });
      expect(third.items.map((i) => i.id)).toEqual([idOlder]);
      expect(third.nextCursor).toBeNull();

      const allIds = [...first.items, ...second.items, ...third.items].map(
        (i) => i.id,
      );
      expect(allIds).toEqual([idHigh, idLow, idOlder]);
      expect(new Set(allIds).size).toBe(3);
    });

    it("rejects a malformed cursor with a 400", async () => {
      fake.follows.push({ followerId: CALLER_ID, followingId: TARGET_ID });

      await expect(
        service.getFeed(CALLER_CLERK, { cursor: "not-a-uuid" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
