import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import { UUID_PATTERN } from "./reviews.constants.js";

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
      comments: review.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
        author: toAuthor(comment.user.profile),
        isOwn: viewerId !== null && comment.userId === viewerId,
      })),
      viewer: { hasLiked, canInteract: viewerId !== null },
    };
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
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException("review id must be a valid id.");
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

/** The profile projection shared by the review author and every comment author. */
const PROFILE_SELECT = {
  username: true,
  displayName: true,
  avatarUrl: true,
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
  comments: {
    orderBy: COMMENT_ORDER_BY,
    select: {
      id: true,
      userId: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { profile: { select: PROFILE_SELECT } } },
    },
  },
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
  comments: {
    id: string;
    userId: string;
    body: string;
    createdAt: Date;
    updatedAt: Date;
    user: { profile: ProfileRow | null };
  }[];
}
