import { BadRequestException, Injectable } from "@nestjs/common";
import type { NotificationType } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  COMMENT_EXCERPT_LENGTH,
  DEFAULT_NOTIFICATION_LIMIT,
  MAX_NOTIFICATION_LIMIT,
  UUID_PATTERN,
} from "./notifications.constants.js";

/** Query options accepted by {@link NotificationsService.list}. */
export interface NotificationQuery {
  /** Opaque cursor (a previous item's `id`); returns the page AFTER it. */
  cursor?: string;
  /** Requested page size (clamped to [1, {@link MAX_NOTIFICATION_LIMIT}]). */
  limit?: string | number;
}

/** The user whose action produced a notification (a required, cascading FK). */
export interface NotificationActor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** One entry in the caller's notification list. */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  createdAt: string;
  /** ISO timestamp of when this was read, or `null` while it is still unread. */
  readAt: string | null;
  actor: NotificationActor;
  /**
   * The review to link a COMMENT notification at, or `null`. Reached through
   * the `reviewComment` relation, so it is `null` for every FOLLOW row (which
   * carries no target FK at all) — link building stays in the web layer.
   */
  reviewId: string | null;
  /**
   * The first {@link COMMENT_EXCERPT_LENGTH} characters of the comment body for
   * a COMMENT notification, else `null`. `null` means "there is nothing to
   * preview", which stays distinguishable from an empty preview.
   */
  commentExcerpt: string | null;
}

/** A single cursor-paginated page of the caller's notifications. */
export interface NotificationPage {
  items: NotificationItem[];
  /** Cursor for the next (older) page, or `null` when this is the last page. */
  nextCursor: string | null;
  /**
   * The caller's unread total, riding along in the same round-trip so opening
   * the dropdown reconciles the badge with no third request and no flicker
   * (design Decision 12).
   */
  unreadCount: number;
}

/** The badge payload returned by the polled count endpoint. */
export interface UnreadCountResult {
  unreadCount: number;
}

/** Row shape returned by {@link NOTIFICATION_SELECT}. */
interface NotificationRow {
  id: string;
  type: NotificationType;
  createdAt: Date;
  readAt: Date | null;
  actor: { profile: ProfileRow | null };
  reviewComment: { reviewId: string; body: string } | null;
}

/** Profile projection returned by {@link PROFILE_SELECT}. */
interface ProfileRow {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The actor projection, matching the feed's and reviews' author selects. */
const PROFILE_SELECT = {
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

/**
 * The projection of one notification. The nested actor profile and comment ride
 * along in the SAME query, so rendering a page costs zero extra round-trips and
 * cannot N+1 — the same discipline as the feed's nested `_count`.
 */
const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  createdAt: true,
  readAt: true,
  actor: { select: { profile: { select: PROFILE_SELECT } } },
  reviewComment: { select: { reviewId: true, body: true } },
} as const;

/**
 * In-app notifications (Fase 2 slice 4): backs the read surface,
 * `GET /notifications` and `GET /notifications/unread-count`. Both return ONLY
 * the authenticated caller's own rows — a notification is private to its
 * recipient, so there is no public or cross-user view of this data.
 *
 * Runs behind the global `ClerkGuard`, so the caller is always authenticated,
 * but the caller's LOCAL `User` row may not exist yet (the Clerk webhook sync is
 * eventually consistent). Both reads degrade to an empty page / a zero count
 * rather than a 404, matching `getFeed` and `getOwnActivity`: an unsynced
 * account has no notifications to show anyway, and a 404 on a private resource
 * would be a worse answer than an honest empty one (design Decision 14).
 *
 * Pagination reuses the personal-stream contract verbatim — opaque `id` cursor,
 * `[createdAt desc, id desc]` ordering, `take limit + 1` — so pages never skip
 * or repeat a row when two notifications share a `createdAt`.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns one cursor-paginated page of the caller's notifications, newest
   * first, plus their unread total. The count is issued in parallel with the
   * page (one extra indexed `count`, no N+1) so the dropdown can reconcile the
   * badge in the same round-trip.
   */
  async list(
    clerkUserId: string,
    query: NotificationQuery = {},
  ): Promise<NotificationPage> {
    const limit = this.resolveLimit(query.limit);
    const cursor = this.resolveCursor(query.cursor);

    const recipientUserId = await this.resolveUserId(clerkUserId);
    if (recipientUserId === null) {
      // Local user row not synced yet — nothing addressed to this caller.
      return { items: [], nextCursor: null, unreadCount: 0 };
    }

    // Fetch one extra row to detect a further page without a second count
    // query. The secondary `id` sort keeps the ordering deterministic when two
    // notifications share a `createdAt` (a burst of comments in one request),
    // so the cursor never skips or repeats a row across a page boundary.
    //
    // A well-formed cursor id matching no row resolves to an empty page rather
    // than throwing: Prisma's anchor lookup is a scalar comparison that is NULL
    // when nothing matches, so the WHERE clause matches nothing. Same semantics
    // proven for `GET /me/activity` and `GET /feed`.
    const [rows, unreadCount] = (await Promise.all([
      this.prisma.client.notification.findMany({
        where: { recipientUserId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: NOTIFICATION_SELECT,
      }),
      this.countUnread(recipientUserId),
    ])) as [NotificationRow[], number];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => toItem(row)),
      nextCursor: hasMore && last ? last.id : null,
      unreadCount,
    };
  }

  /**
   * The caller's unread total — the only thing the web app's 30s poll loop
   * calls, so it stays a single index-covered `count` with a ~20-byte response
   * rather than a 20-item join (design Decision 12).
   */
  async getUnreadCount(clerkUserId: string): Promise<UnreadCountResult> {
    const recipientUserId = await this.resolveUserId(clerkUserId);
    if (recipientUserId === null) {
      return { unreadCount: 0 };
    }
    return { unreadCount: await this.countUnread(recipientUserId) };
  }

  /** Unread rows for one recipient, covered by the `[recipientUserId, readAt]` index. */
  private countUnread(recipientUserId: string): Promise<number> {
    return this.prisma.client.notification.count({
      where: { recipientUserId, readAt: null },
    });
  }

  /**
   * Resolves the caller's local `User.id`, or `null` when no local row exists
   * yet. Both read paths degrade on `null` instead of throwing — the same
   * read/write asymmetry the activity and social modules already apply.
   */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Clamps the requested page size to [1, MAX], defaulting when unspecified. */
  private resolveLimit(value: string | number | undefined): number {
    if (value === undefined || value === "") {
      return DEFAULT_NOTIFICATION_LIMIT;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException("limit must be a positive integer.");
    }
    return Math.min(parsed, MAX_NOTIFICATION_LIMIT);
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
}

/** Maps a persisted notification row to its API view. */
function toItem(row: NotificationRow): NotificationItem {
  const profile = row.actor.profile;
  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    // `actor` is a required, cascading FK so the relation always resolves, but
    // `Profile` is optional on `User` — degrade the FIELDS rather than throw,
    // reusing the feed's `toFeedItem` and reviews' `toAuthor` fallback verbatim.
    actor: {
      username: profile?.username ?? "",
      displayName: profile?.displayName ?? "",
      avatarUrl: profile?.avatarUrl ?? null,
    },
    // Both COMMENT-only projections hang off the same nullable relation, so a
    // FOLLOW row (no target FK) reports `null` for both rather than "".
    reviewId: row.reviewComment?.reviewId ?? null,
    commentExcerpt: row.reviewComment
      ? toExcerpt(row.reviewComment.body)
      : null,
  };
}

/** Cuts a comment body down to the dropdown preview length (no ellipsis added). */
function toExcerpt(body: string): string {
  return body.length > COMMENT_EXCERPT_LENGTH
    ? body.slice(0, COMMENT_EXCERPT_LENGTH)
    : body;
}
