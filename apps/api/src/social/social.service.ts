import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ActivityType } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  DEFAULT_FEED_LIMIT,
  MAX_FEED_LIMIT,
  UUID_PATTERN,
} from "./social.constants.js";

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

/** Query options accepted by {@link SocialService.getFeed}. */
export interface FeedQuery {
  /** Opaque cursor (a previous item's `id`); returns the page AFTER it. */
  cursor?: string;
  /** Requested page size (clamped to [1, {@link MAX_FEED_LIMIT}]). */
  limit?: string | number;
}

/** The user who produced a feed event (the followed author). */
export interface FeedActor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The album a feed event refers to (always present — a required FK). */
export interface FeedItemAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/**
 * One entry in the followed-activity feed. Shares the personal-stream item shape
 * (`GET /me/activity`) — same orphan-safe `score`/`reviewBody` rendering — plus
 * an `actor` identifying which followed user produced the event.
 */
export interface FeedItem {
  id: string;
  type: ActivityType;
  occurredAt: string;
  album: FeedItemAlbum;
  /** RATING score from the event's `payload` snapshot, else `null`. */
  score: number | null;
  /** REVIEW body from the `SetNull` relation, degrading to `null`. */
  reviewBody: string | null;
  /** The followed user who produced this event. */
  actor: FeedActor;
}

/** A single cursor-paginated page of followed-activity events. */
export interface FeedPage {
  items: FeedItem[];
  /** Cursor for the next (older) page, or `null` when this is the last page. */
  nextCursor: string | null;
}

interface FeedEventRow {
  id: string;
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
  user: {
    profile: {
      username: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
  };
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
   * Followed-activity feed backing `GET /feed`: the `ActivityEvent`s of every
   * user the caller follows, reverse-chronological and cursor-paginated. It fans
   * IN over the follow graph — the inverse of the personal stream
   * (`GET /me/activity`), which shows only the caller's own events — but reuses
   * that endpoint's exact pagination contract (`[occurredAt desc, id desc]`
   * tie-break, `take limit+1`, opaque `id` cursor), so pages never skip or repeat
   * a row.
   *
   * The query is two-step by design (Decision "Feed query"): resolve the small
   * `followingId[]` set from `Follow`, then `ActivityEvent where userId IN (...)`.
   * An empty follow set (or an unsynced caller with no local `User` row) short-
   * circuits to an empty page rather than issuing an `IN ()` scan or a 404 —
   * mirroring the activity stream's degrade-to-empty behavior. The model is open:
   * no reciprocity or privacy check beyond "the event's owner is followed."
   *
   * Rendering is orphan-safe, identical to the personal stream: the RATING score
   * comes from the event's own `payload` snapshot and the REVIEW body from a
   * `SetNull` relation, so a stranded event degrades gracefully instead of
   * crashing the feed. Each item additionally carries its `actor` (the followed
   * author), fetched in the same query via a nested profile select (no N+1).
   */
  async getFeed(
    clerkUserId: string,
    query: FeedQuery = {},
  ): Promise<FeedPage> {
    const limit = this.resolveLimit(query.limit);
    const cursor = this.resolveCursor(query.cursor);

    const followerId = await this.resolveUserId(clerkUserId);
    if (followerId === null) {
      // Local user row not synced yet — no follow graph, so nothing to show.
      return { items: [], nextCursor: null };
    }

    const following = await this.prisma.client.follow.findMany({
      where: { followerId },
      select: { followingId: true },
    });
    const followingIds = following.map((f) => f.followingId);
    if (followingIds.length === 0) {
      // Following nobody — short-circuit before an `IN ()` fan-in query.
      return { items: [], nextCursor: null };
    }

    // Fetch one extra row to detect a further page without a second count query.
    // The secondary `id` sort makes ordering deterministic when two events share
    // the same `occurredAt`, so the cursor never skips or repeats across page
    // boundaries — the same contract proven for `GET /me/activity`.
    const rows = (await this.prisma.client.activityEvent.findMany({
      where: { userId: { in: followingIds } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        occurredAt: true,
        payload: true,
        album: {
          select: {
            id: true,
            title: true,
            coverUrl: true,
            primaryArtist: { select: { name: true } },
          },
        },
        review: { select: { body: true } },
        user: {
          select: {
            profile: {
              select: {
                username: true,
                displayName: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    })) as FeedEventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => this.toFeedItem(row)),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  private toFeedItem(row: FeedEventRow): FeedItem {
    const profile = row.user.profile;
    return {
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt.toISOString(),
      album: {
        id: row.album.id,
        title: row.album.title,
        coverUrl: row.album.coverUrl,
        primaryArtistName: row.album.primaryArtist.name,
      },
      score:
        row.type === ActivityType.RATING ? extractScore(row.payload) : null,
      reviewBody: row.review?.body ?? null,
      // A followed user always has a profile (you follow by username), but the
      // relation is nullable in the schema, so degrade defensively rather than
      // throw — consistent with the feed's orphan-safe rendering ethos.
      actor: {
        username: profile?.username ?? "",
        displayName: profile?.displayName ?? "",
        avatarUrl: profile?.avatarUrl ?? null,
      },
    };
  }

  /** Clamps the requested page size to [1, MAX], defaulting when unspecified. */
  private resolveLimit(value: string | number | undefined): number {
    if (value === undefined || value === "") {
      return DEFAULT_FEED_LIMIT;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException("limit must be a positive integer.");
    }
    return Math.min(parsed, MAX_FEED_LIMIT);
  }

  /** Validates the cursor's UUID shape (clean 400) before it reaches Postgres. */
  private resolveCursor(value: string | undefined): string | null {
    if (value === undefined || value === "") {
      return null;
    }
    const trimmed = value.trim();
    if (!UUID_PATTERN.test(trimmed)) {
      throw new BadRequestException("cursor must be a valid id.");
    }
    return trimmed;
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

/**
 * Reads a numeric `score` off an event's JSON `payload` snapshot, tolerating a
 * null/absent/malformed payload — a stranded RATING event whose payload never
 * carried a score simply renders without one rather than throwing. Kept local to
 * the social module (the activity module has its own copy) so the two feature
 * modules stay decoupled, matching the codebase's per-module constant duplication.
 */
function extractScore(payload: unknown): number | null {
  if (payload && typeof payload === "object" && "score" in payload) {
    const score = (payload as { score: unknown }).score;
    if (typeof score === "number" && Number.isFinite(score)) {
      return score;
    }
  }
  return null;
}
