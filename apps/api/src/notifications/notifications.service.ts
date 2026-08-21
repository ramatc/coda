import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { NotificationType } from "@coda/db";
import { isUniqueConstraintViolation } from "../prisma/prisma-error.util.js";
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
 * In-app notifications (Fase 2 slice 4): backs `GET /notifications`,
 * `GET /notifications/unread-count` and `POST /notifications/read-all`. All
 * three touch ONLY the authenticated caller's own rows — a notification is
 * private to its recipient, so there is no public or cross-user view of this
 * data, and every query scopes on `recipientUserId`.
 *
 * It also owns the two WRITE helpers — {@link NotificationsService.notifyFollow}
 * and {@link NotificationsService.notifyComment} — which have no HTTP surface at
 * all. They are called from inside `follow()` and `createComment()`, so unlike
 * the read methods they take LOCAL user ids that the caller already resolved,
 * never a clerk id.
 *
 * Runs behind the global `ClerkGuard`, so the caller is always authenticated,
 * but the caller's LOCAL `User` row may not exist yet (the Clerk webhook sync is
 * eventually consistent). All three methods degrade to an empty page / a zero
 * count rather than a 404, matching `getFeed` and `getOwnActivity`: an unsynced
 * account has no notifications to show anyway, and a 404 on a private resource
 * would be a worse answer than an honest empty one (design Decision 14).
 *
 * Pagination reuses the personal-stream contract verbatim — opaque `id` cursor,
 * `[createdAt desc, id desc]` ordering, `take limit + 1` — so pages never skip
 * or repeat a row when two notifications share a `createdAt`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

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

  /**
   * Marks every one of the caller's currently-unread notifications as read, and
   * reports the resulting (always zero) badge. Fired when the web dropdown
   * opens: the v1 dropdown shows the whole recent set at once, so "the user
   * opened it" IS "the user saw them" (design Decision 13). Per-item read is
   * deliberately out of v1 scope.
   *
   * Scoping the update to `readAt: null` is load-bearing twice over: it PRESERVES
   * the original timestamp of rows read earlier (an unscoped `updateMany` would
   * restamp them to "now" on every open, destroying when the user actually saw
   * them), and it makes a replay a genuine no-op rather than a rewrite.
   *
   * The posture is tolerant (design Decision 14) — matching nothing is a success,
   * not a 404, and an unsynced caller gets the same cleared badge as everyone
   * else. Unlike the social/tracking write paths there is no `requireCallerId`
   * here on purpose: a notification is PRIVATE to its recipient, so a 403/404
   * would confirm the existence of rows the caller may not observe, and an
   * account with no local row owns no notifications anyway.
   */
  async markAllRead(clerkUserId: string): Promise<UnreadCountResult> {
    const recipientUserId = await this.resolveUserId(clerkUserId);
    if (recipientUserId !== null) {
      await this.prisma.client.notification.updateMany({
        where: { recipientUserId, readAt: null },
        data: { readAt: new Date() },
      });
    }
    // Zero by construction: every row that could have counted was just stamped.
    // Returning the same `{ unreadCount }` shape as the polled endpoint lets the
    // dropdown reconcile its badge from this response with no extra round-trip.
    return { unreadCount: 0 };
  }

  /**
   * Records that `actorUserId` started following `recipientUserId`. Called from
   * inside `follow()` once the `Follow` row is committed, so both arguments are
   * LOCAL `User.id`s, never clerk ids.
   *
   * Self-suppression lives here rather than at the call site (design Decision 4):
   * `follow()` already 400s a self-follow, which makes this branch structurally
   * unreachable TODAY — and that is precisely the argument for keeping the
   * invariant in one place, because it becomes reachable the moment a second
   * caller appears.
   *
   * The insert is attempted DIRECTLY, with no `findFirst` pre-check. Refollow
   * spam (an unfollow→refollow loop would otherwise mint an unbounded stream of
   * notifications and emails at the victim) is stopped by
   * `notifications_active_follow_dedup_idx` — a partial unique index on
   * `(recipient_user_id, actor_user_id, type)` scoped to
   * `WHERE read_at IS NULL AND type = 'FOLLOW'` (design Decision 17). A pre-check
   * would leave a TOCTOU window where two concurrent calls both pass the lookup
   * before either insert lands; letting the database arbitrate closes it.
   *
   * The two failure modes are therefore NOT the same thing and must not be
   * logged the same way (design Decision 6):
   * - a unique-constraint violation means "this recipient already has an unread
   *   follow notification from this actor". That is an EXPECTED outcome of a
   *   normal refollow, so it is a silent no-op — no row, and deliberately no
   *   warning, or every ordinary refollow would read as a production error.
   * - anything else is a genuine failure: warn-logged, then rethrown so the hook
   *   site's own `try/catch` can absorb it and still return its 200. A lost
   *   notification must never fail the follow it describes.
   */
  async notifyFollow(
    actorUserId: string,
    recipientUserId: string,
  ): Promise<void> {
    if (actorUserId === recipientUserId) {
      return;
    }

    try {
      await this.prisma.client.notification.create({
        data: { recipientUserId, actorUserId, type: NotificationType.FOLLOW },
      });
    } catch (err) {
      // KNOWN LIMITATION (accepted, revisit on change): `isUniqueConstraintViolation`
      // classifies on the Prisma P2002 CODE alone
      // — it does not tell us WHICH unique constraint fired. That is
      // unambiguous today because `notifications` has exactly ONE non-PK
      // unique index (the dedup index above), so any P2002 from this insert
      // can only be that one. If a second unique constraint is ever added to
      // this table, this catch would start swallowing unrelated collisions as
      // if they were refollows. The fix at that point is to discriminate with
      // `extractUniqueConstraintField(err)`, the way `lists.addItem` already
      // does — see the same reasoning recorded on `reviews.likeReview`.
      if (isUniqueConstraintViolation(err)) {
        return;
      }
      this.logger.warn(
        `Could not create follow notification for user ${recipientUserId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Records that `actorUserId` commented on `recipientUserId`'s review. Same
   * local-id contract as {@link NotificationsService.notifyFollow}, called from
   * inside `createComment()` after the comment is committed.
   *
   * Self-suppression is LIVE here, not theoretical: the reviews slice explicitly
   * allows commenting on your own review, so this guard is the only thing
   * stopping an author from notifying themselves (design Decision 4).
   *
   * A plain insert with no catch, because there is nothing expected to absorb:
   * the dedup index is scoped to `type = 'FOLLOW'`, so a second comment from the
   * same actor is a legitimate second notification and must produce a second row.
   * Any failure propagates to the hook site's `try/catch`, which logs it and
   * still returns the created comment.
   */
  async notifyComment(
    actorUserId: string,
    recipientUserId: string,
    reviewCommentId: string,
  ): Promise<void> {
    if (actorUserId === recipientUserId) {
      return;
    }

    // No catch here BY DESIGN: unlike `notifyFollow`, there is no dedup-noop
    // to discriminate from a genuine failure, so an insert failure is expected
    // to propagate as-is to the Phase 6/7 hook site's own try/catch.
    await this.prisma.client.notification.create({
      data: {
        recipientUserId,
        actorUserId,
        type: NotificationType.COMMENT,
        reviewCommentId,
      },
    });
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
