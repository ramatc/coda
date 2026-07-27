import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  MAX_COMMENT_LENGTH,
  UUID_PATTERN,
  ZERO_WIDTH_PATTERN,
} from "./reviews.constants.js";

/** The profile shown next to a review or one of its comments. */
export interface ReviewAuthor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The album a review is about (always present — a required FK). */
export interface ReviewAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** One comment on a review, with the caller's ownership already resolved. */
export interface ReviewCommentView {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: ReviewAuthor;
  /** `true` only when the authenticated, synced caller wrote this comment. */
  isOwn: boolean;
}

/**
 * The caller's own relationship to the review. Both fields are `false` for an
 * anonymous caller, a caller with an invalid/expired token, and a signed-in
 * caller whose Clerk account has not been synced to a local `User` row yet.
 */
export interface ReviewViewer {
  hasLiked: boolean;
  /** `true` when the caller resolved to a local `User.id` and may write. */
  canInteract: boolean;
}

/**
 * The counter projection returned by like/unlike. Deliberately NOT a
 * created-resource representation — hence `@HttpCode(200)` on both verbs.
 */
export interface ReviewLikeResult {
  likeCount: number;
  hasLiked: boolean;
}

/** Body accepted by comment create and edit. `unknown` because it is raw input. */
export interface CommentInput {
  body?: unknown;
}

/** The full detail of a single review, consumed by `apps/web/app/reviews/[id]`. */
export interface ReviewDetail {
  id: string;
  body: string;
  isSpoiler: boolean;
  createdAt: string;
  updatedAt: string;
  album: ReviewAlbum;
  author: ReviewAuthor;
  likeCount: number;
  commentCount: number;
  comments: ReviewCommentView[];
  viewer: ReviewViewer;
}

/**
 * Review social surface (Fase 2 slice 3): owns the `reviewId`-keyed resource
 * family — the anonymously-readable review detail plus (from the write-path
 * slice) likes and comment CRUD. Deliberately a module of its own rather than
 * an extension of `tracking` (the `albumId`-keyed write surface), so the app's
 * FIRST auth exemption is isolated in a controller whose only anonymous-tolerant
 * method is the read.
 *
 * ## The anonymous-read contract (read this before editing {@link getReview})
 *
 * `GET /reviews/:id` carries both `@Public()` and `@UseGuards(OptionalClerkGuard)`,
 * so `@CurrentUser("sub")` is `string | undefined` here — the ONLY place in the
 * app where that can happen; every other service is guaranteed a string by the
 * fail-closed global `ClerkGuard`. {@link getReview} therefore MUST short-circuit
 * on a missing caller BEFORE any Prisma call: passing `undefined` into
 * `findUnique({ where: { clerkUserId } })` raises a `PrismaClientValidationError`,
 * which would surface as an unhandled 500 on EVERY anonymous hit.
 *
 * Viewer resolution uses {@link resolveUserId} (null-tolerant), never
 * `requireCallerId`: a read must not 404 a signed-in user whose Clerk webhook
 * sync has not landed yet. They simply degrade to the anonymous viewer block —
 * the same posture `ListsService.getList` takes.
 */
@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a review with its album, author, counts, ordered comments and the
   * caller's viewer block. Readable anonymously: `clerkUserId` is `undefined`
   * for a caller with no token AND for one whose token failed verification
   * (`OptionalClerkGuard` degrades both to anonymous rather than throwing 401).
   * An unknown review id is a 404; a malformed one is a 400.
   */
  async getReview(
    clerkUserId: string | undefined,
    reviewId: unknown,
  ): Promise<ReviewDetail> {
    const id = this.validateReviewId(reviewId);
    // Anonymous short-circuit: no Prisma call may see an `undefined` caller.
    const viewerId = clerkUserId ? await this.resolveUserId(clerkUserId) : null;

    const review = (await this.prisma.client.review.findUnique({
      where: { id },
      select: REVIEW_DETAIL_SELECT,
    })) as ReviewRow | null;
    if (!review) {
      throw new NotFoundException("Review not found.");
    }

    const hasLiked = await this.hasViewerLiked(viewerId, id);

    return {
      id: review.id,
      body: review.body,
      isSpoiler: review.isSpoiler,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
      album: {
        id: review.album.id,
        title: review.album.title,
        coverUrl: review.album.coverUrl,
        primaryArtistName: review.album.primaryArtist.name,
      },
      author: toAuthor(review.user.profile),
      likeCount: review._count.likes,
      commentCount: review._count.comments,
      comments: review.comments.map((comment) =>
        toCommentView(comment, viewerId),
      ),
      viewer: { hasLiked, canInteract: viewerId !== null },
    };
  }

  /**
   * Likes a review on the caller's behalf. Reviews live on albums (public data),
   * so there is no visibility rule to enforce and self-liking is allowed.
   *
   * The write is a plain `create()` with the database as the single arbiter — no
   * `findUnique` pre-check (which would open a TOCTOU window that surfaces as a
   * raw P2002 500 under concurrency) and deliberately NOT `follow()`'s
   * `upsert` + empty `update` idempotency, because the spec's duplicate-like
   * scenario normatively requires a 409. Idempotency is guaranteed at the DATA
   * layer instead: `@@id([userId, reviewId])` means a second row can never
   * exist, and the 409 is the honest report that the write was refused.
   *
   * That composite PK is also the ONLY unique constraint on `review_likes`, so a
   * bare {@link isUniqueConstraintViolation} check is unambiguous — do NOT add
   * `extractUniqueConstraintField` discrimination here the way `lists.addItem`
   * needs it; the leading column (`user_id`) does not discriminate anything.
   * A P2003 means the review vanished between page load and click (or the link
   * was stale) and is a 404, not a 500.
   */
  async likeReview(
    clerkUserId: string,
    reviewId: unknown,
  ): Promise<ReviewLikeResult> {
    const id = this.validateReviewId(reviewId);
    const userId = await this.requireCallerId(clerkUserId);

    try {
      await this.prisma.client.reviewLike.create({
        data: { userId, reviewId: id },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new ConflictException("You already liked this review.");
      }
      if (isForeignKeyViolation(err)) {
        throw new NotFoundException("Review not found.");
      }
      throw err;
    }

    return { likeCount: await this.countLikes(id), hasLiked: true };
  }

  /**
   * Removes the caller's like. Tolerant by design: `deleteMany` scoped to the
   * caller's own row means unliking something never liked is a 200 no-op rather
   * than a 409/404. The spec only ever constrains the duplicate-LIKE direction,
   * so the 409 must not be mirrored here — this matches the follow/unfollow
   * precedent, where only `unfollow` uses the tolerant `deleteMany`.
   */
  async unlikeReview(
    clerkUserId: string,
    reviewId: unknown,
  ): Promise<ReviewLikeResult> {
    const id = this.validateReviewId(reviewId);
    const userId = await this.requireCallerId(clerkUserId);

    await this.prisma.client.reviewLike.deleteMany({
      where: { userId, reviewId: id },
    });

    return { likeCount: await this.countLikes(id), hasLiked: false };
  }

  /**
   * Adds a plain-text comment (≤500 chars) to a review. Self-commenting is
   * allowed. An unknown review id violates the `ReviewComment.reviewId` FK
   * (P2003) and is mapped to a 404 rather than escaping as a raw 500 — the same
   * stale-target handling as {@link likeReview}.
   */
  async createComment(
    clerkUserId: string,
    reviewId: unknown,
    input: CommentInput,
  ): Promise<ReviewCommentView> {
    const id = this.validateReviewId(reviewId);
    const userId = await this.requireCallerId(clerkUserId);
    const body = this.validateCommentBody(input?.body);

    try {
      const created = (await this.prisma.client.reviewComment.create({
        data: { reviewId: id, userId, body },
        select: COMMENT_SELECT,
      })) as CommentRow;
      return toCommentView(created, userId);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new NotFoundException("Review not found.");
      }
      throw err;
    }
  }

  /**
   * Edits the caller's own comment. See {@link loadOwnComment} for why the authz
   * check and the write are two separate steps.
   *
   * ## Why there is no read-back after the write
   *
   * The response is assembled from what THIS request already knows, never from
   * a third query re-reading the row. A re-read would open a real race: a second
   * concurrent `PATCH` from the SAME caller (a double-submit, or a second tab)
   * landing between this request's `updateMany` and its read-back would make the
   * read-back return the OTHER request's body — so this caller gets a 200 whose
   * `body` is not what they submitted.
   *
   * Every field is therefore sourced race-free:
   * - `body` is exactly the validated input handed to `updateMany`.
   * - `updatedAt` is stamped HERE and written explicitly, instead of letting
   *   `@updatedAt` generate it and needing a read to observe it.
   * - `id`, `createdAt` and the author are immutable for the life of the row, so
   *   taking them from the pre-write authz load carries no staleness.
   */
  async updateComment(
    clerkUserId: string,
    reviewId: unknown,
    commentId: unknown,
    input: CommentInput,
  ): Promise<ReviewCommentView> {
    const id = this.validateReviewId(reviewId);
    const targetId = this.validateCommentId(commentId);
    const userId = await this.requireCallerId(clerkUserId);
    const body = this.validateCommentBody(input?.body);

    const existing = await this.loadOwnComment(id, targetId, userId);

    const updatedAt = new Date();
    const { count } = await this.prisma.client.reviewComment.updateMany({
      where: { id: targetId, reviewId: id, userId },
      data: { body, updatedAt },
    });
    if (count === 0) {
      throw new NotFoundException("Comment not found.");
    }

    return toCommentView({ ...existing, body, updatedAt }, userId);
  }

  /** Deletes the caller's own comment. Authz mirrors {@link updateComment}. */
  async deleteComment(
    clerkUserId: string,
    reviewId: unknown,
    commentId: unknown,
  ): Promise<void> {
    const id = this.validateReviewId(reviewId);
    const targetId = this.validateCommentId(commentId);
    const userId = await this.requireCallerId(clerkUserId);

    await this.loadOwnComment(id, targetId, userId);

    const { count } = await this.prisma.client.reviewComment.deleteMany({
      where: { id: targetId, reviewId: id, userId },
    });
    if (count === 0) {
      throw new NotFoundException("Comment not found.");
    }
  }

  /**
   * Two-step comment authorization (design Decision 6). Loads the comment
   * SCOPED to its parent review, then compares authorship:
   *
   * - no such comment under this review → **404** (this is what stops a caller
   *   editing a comment that belongs to a DIFFERENT review by supplying its id)
   * - someone else's comment → **403** (comments are public data, so a non-author
   *   mutation is an honest authz failure, not hidden existence)
   *
   * The callers then still write through `updateMany`/`deleteMany` scoped by
   * `{ id, reviewId, userId }` and treat `count === 0` as a 404. That is NOT
   * redundant: it is the race net for a concurrent delete landing in the gap
   * this two-step opens. A single scoped `deleteMany` alone would collapse 403
   * into 404 and hide real authz failures; a bare `update()`/`delete()` would
   * raise P2025 → 500. Never replace this pair with either shortcut.
   *
   * Returns the authorized row on the full {@link COMMENT_SELECT} projection so
   * {@link updateComment} can answer from it instead of re-reading after the
   * write. Only the row's IMMUTABLE fields (`id`, `createdAt`, author) may be
   * used that way — `body` and `updatedAt` are supplied by the writing request.
   * {@link deleteComment} ignores the value and uses this purely as the guard.
   */
  private async loadOwnComment(
    reviewId: string,
    commentId: string,
    callerId: string,
  ): Promise<CommentRow> {
    const comment = (await this.prisma.client.reviewComment.findFirst({
      where: { id: commentId, reviewId },
      select: COMMENT_SELECT,
    })) as CommentRow | null;
    if (!comment) {
      throw new NotFoundException("Comment not found.");
    }
    if (comment.userId !== callerId) {
      throw new ForbiddenException("You can only edit your own comment.");
    }
    return comment;
  }

  /** Current like total for a review, read back after a like/unlike write. */
  private async countLikes(reviewId: string): Promise<number> {
    return this.prisma.client.reviewLike.count({ where: { reviewId } });
  }

  /**
   * Whether the resolved viewer has liked this review. A `null` viewer (anonymous,
   * bad token, or unsynced) never reaches Prisma — there is no local id to key
   * the composite lookup on.
   */
  private async hasViewerLiked(
    viewerId: string | null,
    reviewId: string,
  ): Promise<boolean> {
    if (viewerId === null) {
      return false;
    }
    const like = await this.prisma.client.reviewLike.findUnique({
      where: { userId_reviewId: { userId: viewerId, reviewId } },
      select: { userId: true },
    });
    return like !== null;
  }

  /** Validates a UUID-shaped review id before it reaches Postgres (clean 400). */
  private validateReviewId(value: unknown): string {
    return this.validateUuid(value, "review id");
  }

  /** Validates a UUID-shaped comment id before it reaches Postgres (clean 400). */
  private validateCommentId(value: unknown): string {
    return this.validateUuid(value, "comment id");
  }

  /** Shared UUID shape guard: a malformed id is a 400, never a Postgres 500. */
  private validateUuid(value: unknown, label: string): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException(`${label} must be a valid id.`);
  }

  /**
   * A required, non-empty, length-bounded comment body (trimmed). Plain text
   * only — no rich formatting and no @mentions in this slice. The bound is
   * enforced HERE rather than left to `ReviewComment.body @db.VarChar(500)`, so
   * an over-long body is a clean 400 instead of a driver-level truncation error.
   *
   * Emptiness is decided on the body with {@link ZERO_WIDTH_PATTERN} removed:
   * `String.prototype.trim()` strips whitespace but NOT zero-width/format code
   * points, so a body of only U+200B/200C/200D/FEFF would otherwise read as
   * "non-empty" and persist a comment that renders visually blank. Some
   * clipboard sources inject a stray ZWSP, so this is reachable through
   * ordinary use, not just deliberate abuse.
   *
   * The stripping is scoped to the emptiness TEST only — it is not a sanitizer.
   * The length bound and the stored value both stay on the plain `trim()`, so a
   * body mixing zero-width characters with real text is persisted verbatim.
   */
  private validateCommentBody(value: unknown): string {
    if (
      typeof value !== "string" ||
      value.replace(ZERO_WIDTH_PATTERN, "").trim().length === 0
    ) {
      throw new BadRequestException("body is required.");
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new BadRequestException(
        `body must be at most ${MAX_COMMENT_LENGTH} characters.`,
      );
    }
    return trimmed;
  }

  /**
   * Resolves the caller's local `User.id`, or `null` when not synced yet.
   * Mirrors `ListsService`/`SocialService` verbatim. Read paths stay
   * null-tolerant; only write paths escalate a missing row to a 404.
   */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /**
   * Write-path caller resolution: the same lookup as {@link resolveUserId} but a
   * missing local row is a 404 instead of a degrade. Every method in this
   * service EXCEPT {@link getReview} uses this — a read must not 404 a viewer
   * whose Clerk webhook sync has not landed, but a write has no local `User.id`
   * to attribute the row to, so it cannot proceed.
   */
  private async requireCallerId(clerkUserId: string): Promise<string> {
    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      throw new NotFoundException("No local account for the current user.");
    }
    return userId;
  }
}

/**
 * A `Profile` is optional on `User` in the schema, so degrade defensively
 * rather than throw — consistent with the feed's orphan-safe rendering ethos
 * (`social.service.ts`). A review always has an author with a profile in
 * practice (profiles are created by the Clerk webhook sync).
 */
function toAuthor(profile: ProfileRow | null): ReviewAuthor {
  return {
    username: profile?.username ?? "",
    displayName: profile?.displayName ?? "",
    avatarUrl: profile?.avatarUrl ?? null,
  };
}

/** Maps a persisted comment row to the API view, resolving the caller's ownership. */
function toCommentView(
  row: CommentRow,
  viewerId: string | null,
): ReviewCommentView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    author: toAuthor(row.user.profile),
    isOwn: viewerId !== null && row.userId === viewerId,
  };
}

/** The profile projection shared by the review author and every comment author. */
const PROFILE_SELECT = {
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

/**
 * The projection of a single comment, shared by the nested read (inside
 * {@link REVIEW_DETAIL_SELECT}) and the create/edit write paths, so all three
 * return the exact same shape and can share {@link toCommentView}.
 */
const COMMENT_SELECT = {
  id: true,
  userId: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { profile: { select: PROFILE_SELECT } } },
} as const;

/**
 * Comments are ordered oldest-first (a conversation reads top-down), with `id`
 * as a secondary tiebreak so ordering stays deterministic when two comments
 * share a `createdAt` — mirroring the activity/feed cursor's secondary sort.
 */
const COMMENT_ORDER_BY: Prisma.ReviewCommentOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/**
 * The Prisma `select` for a full review detail. Counts come from a nested
 * `_count` in the SAME query (no N+1, no denormalized counter columns), and
 * comments are returned unpaginated by design (slice 3 defers pagination), with
 * an `id` tiebreak so ordering stays deterministic when two comments share a
 * `createdAt`.
 */
const REVIEW_DETAIL_SELECT = {
  id: true,
  body: true,
  isSpoiler: true,
  createdAt: true,
  updatedAt: true,
  album: {
    select: {
      id: true,
      title: true,
      coverUrl: true,
      primaryArtist: { select: { name: true } },
    },
  },
  user: { select: { profile: { select: PROFILE_SELECT } } },
  _count: { select: { likes: true, comments: true } },
  comments: { orderBy: COMMENT_ORDER_BY, select: COMMENT_SELECT },
} as const;

/** Profile projection returned by {@link PROFILE_SELECT}. */
interface ProfileRow {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Row shape returned by {@link REVIEW_DETAIL_SELECT}. */
interface ReviewRow {
  id: string;
  body: string;
  isSpoiler: boolean;
  createdAt: Date;
  updatedAt: Date;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtist: { name: string };
  };
  user: { profile: ProfileRow | null };
  _count: { likes: number; comments: number };
  comments: CommentRow[];
}

/** Row shape returned by {@link COMMENT_SELECT}. */
interface CommentRow {
  id: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  user: { profile: ProfileRow | null };
}
