import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/** Result of a follow/unfollow mutation — the caller's resulting follow state. */
export interface FollowResult {
  /** `true` after a follow, `false` after an unfollow (both idempotent). */
  following: boolean;
}

/** Social-graph counts for a profile, plus the caller's own follow state. */
export interface SocialStats {
  /** How many users follow this profile. */
  followerCount: number;
  /** How many users this profile follows. */
  followingCount: number;
  /** Whether the authenticated caller currently follows this profile. */
  isFollowing: boolean;
}

/**
 * Social graph (Fase 2 slice 1): backs follow/unfollow and the follower/following
 * counts surfaced on a profile. Uses the dormant `Follow` model as-is (composite
 * PK `[followerId, followingId]`) — no migration, no denormalized counters, since
 * `count()` on both directions is index-covered at beta scale (design decision:
 * "Schema change NONE").
 *
 * The follow model is OPEN: no approval step, no reciprocity requirement. A
 * self-follow is rejected at the app layer (Prisma cannot express a CHECK
 * cleanly), and both follow and unfollow are idempotent (upsert / deleteMany),
 * matching the listens/dismiss idempotent-200 convention.
 *
 * Runs behind the global `ClerkGuard`. Write paths (follow/unfollow) require the
 * caller's local `User` row to exist — an unsynced caller is a 404, mirroring the
 * tracking write paths. The stats read degrades gracefully: an unsynced caller
 * simply reports `isFollowing: false` rather than erroring.
 */
@Injectable()
export class SocialService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Follows the user identified by `username`. Idempotent: re-following returns
   * `{ following: true }` without creating a second row (composite PK prevents
   * duplicates). Rejects a self-follow with 400 and an unknown/unsynced target
   * with 404.
   */
  async follow(clerkUserId: string, username: string): Promise<FollowResult> {
    const followerId = await this.requireCallerId(clerkUserId);
    const followingId = await this.requireTargetId(username);
    if (followerId === followingId) {
      throw new BadRequestException("You cannot follow yourself.");
    }

    await this.prisma.client.follow.upsert({
      where: { followerId_followingId: { followerId, followingId } },
      create: { followerId, followingId },
      update: {},
    });

    return { following: true };
  }

  /**
   * Unfollows the user identified by `username`. Idempotent: unfollowing someone
   * you do not follow is a no-op that still returns `{ following: false }` (never
   * a 500), matching the delete-idempotency convention. An unknown/unsynced
   * target is a 404, symmetric with {@link follow}.
   */
  async unfollow(clerkUserId: string, username: string): Promise<FollowResult> {
    const followerId = await this.requireCallerId(clerkUserId);
    const followingId = await this.requireTargetId(username);

    await this.prisma.client.follow.deleteMany({
      where: { followerId, followingId },
    });

    return { following: false };
  }

  /**
   * Returns follower/following counts for the profile identified by `username`,
   * plus whether the authenticated caller currently follows it. Counts derive
   * from live `Follow` rows (no denormalized counter — avoids drift for v1) and
   * both directions are index-covered. An unknown target is a 404; an unsynced
   * caller simply reports `isFollowing: false` (the counts still resolve).
   */
  async getSocialStats(
    clerkUserId: string,
    username: string,
  ): Promise<SocialStats> {
    const targetId = await this.requireTargetId(username);
    const callerId = await this.resolveUserId(clerkUserId);

    const [followerCount, followingCount, isFollowingCount] = await Promise.all([
      this.prisma.client.follow.count({ where: { followingId: targetId } }),
      this.prisma.client.follow.count({ where: { followerId: targetId } }),
      callerId === null
        ? Promise.resolve(0)
        : this.prisma.client.follow.count({
            where: { followerId: callerId, followingId: targetId },
          }),
    ]);

    return {
      followerCount,
      followingCount,
      isFollowing: isFollowingCount > 0,
    };
  }

  /**
   * Resolves the caller's local `User.id`, throwing 404 when no local row exists
   * yet (write paths require a synced account — same convention as the tracking
   * module's write flows).
   */
  private async requireCallerId(clerkUserId: string): Promise<string> {
    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      throw new NotFoundException("No local account for the current user.");
    }
    return userId;
  }

  /** Resolves the caller's local `User.id`, or `null` when not synced yet. */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /**
   * Resolves the target user's local `User.id` from a `username`, throwing 404
   * when no profile matches (unknown user, or a Clerk account not yet synced to
   * a local row). Usernames are canonicalized to lowercase, matching the profile
   * module's storage convention.
   */
  private async requireTargetId(username: string): Promise<string> {
    const profile = await this.prisma.client.profile.findUnique({
      where: { username: username.trim().toLowerCase() },
      select: { userId: true },
    });
    if (!profile) {
      throw new NotFoundException(`No user found for username ${username}.`);
    }
    return profile.userId;
  }
}
