import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ActivityType } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  isRecordNotFound,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  MAX_SCORE,
  MIN_SCORE,
  SCORE_RANGE_ERROR,
  UUID_PATTERN,
} from "./tracking.constants.js";

export interface RateAlbumInput {
  albumId?: unknown;
  score?: unknown;
}

export interface WriteReviewInput {
  albumId?: unknown;
  body?: unknown;
}

export interface ListenResult {
  id: string;
  albumId: string;
  listenedAt: Date;
  /** `false` when an existing listen was returned instead of a new one. */
  created: boolean;
}

export interface RatingAggregate {
  /** Mean score across every user's rating of the album, or `null` if none. */
  average: number | null;
  count: number;
}

export interface RatingResult {
  albumId: string;
  score: number;
  aggregate: RatingAggregate;
  created: boolean;
}

export interface DeleteRatingResult {
  albumId: string;
  /** RATING-type `ActivityEvent`s explicitly removed (design Decision #12). */
  deletedActivityEvents: number;
  /** Whether an associated review was also removed (schema FK dependency). */
  reviewDeleted: boolean;
}

export interface ReviewResult {
  id: string;
  albumId: string;
  body: string;
  created: boolean;
}

/**
 * Album-tracking write model (PR8): mark listened, rate (1-10), review, plus
 * the listen/rating delete paths. Runs behind the global `ClerkGuard`; the
 * controller passes the verified Clerk user id, which this service maps to the
 * local `User.id` — every tracking row (and its `ActivityEvent`) is scoped to
 * that user, so a caller can only mutate their own tracking data.
 *
 * Each write and its `ActivityEvent` are persisted in ONE Prisma transaction
 * (task 8.4). Deletes are the non-obvious part: `ActivityEvent.listenId` and
 * `ActivityEvent.ratingId` are `onDelete: SetNull`, NOT cascade (design
 * Decision #12) — so deleting a listen or a rating must EXPLICITLY delete the
 * associated `ActivityEvent` rows in the same transaction, or an orphaned event
 * with a null foreign key would linger in the activity stream.
 */
@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks an album as listened. Idempotent per (user, album): if a `Listen`
   * already exists it is returned as-is, so re-marking creates neither a
   * duplicate `Listen` nor a duplicate `ActivityEvent` (spec: "Re-marking
   * listened is idempotent"). The `Listen` model carries no (userId, albumId)
   * unique constraint, so idempotency is enforced here at the app layer — safe
   * for Fase 1's single-operator, non-concurrent write model.
   */
  async markListened(
    clerkUserId: string,
    albumId: unknown,
  ): Promise<ListenResult> {
    const userId = await this.resolveUserId(clerkUserId);
    const id = this.validateId(albumId, "albumId");
    await this.assertAlbumExists(id);

    const existing = await this.prisma.client.listen.findFirst({
      where: { userId, albumId: id },
      orderBy: { listenedAt: "desc" },
      select: { id: true, listenedAt: true },
    });
    if (existing) {
      return {
        id: existing.id,
        albumId: id,
        listenedAt: existing.listenedAt,
        created: false,
      };
    }

    const listen = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.listen.create({
        data: { userId, albumId: id },
        select: { id: true, listenedAt: true },
      });
      await tx.activityEvent.create({
        data: {
          userId,
          type: ActivityType.LISTEN,
          albumId: id,
          listenId: created.id,
        },
      });
      return created;
    });

    return {
      id: listen.id,
      albumId: id,
      listenedAt: listen.listenedAt,
      created: true,
    };
  }

  /**
   * Deletes one of the caller's `Listen` records by id. Because
   * `ActivityEvent.listenId` is `SetNull` (not cascade), the associated
   * `ActivityEvent` rows are deleted EXPLICITLY in the same transaction so the
   * listen no longer appears in the activity stream (spec: "Deleting a listen
   * removes it from tracking state and activity").
   */
  async deleteListen(
    clerkUserId: string,
    listenId: unknown,
  ): Promise<{ id: string }> {
    const userId = await this.resolveUserId(clerkUserId);
    const id = this.validateId(listenId, "listenId");

    const listen = await this.prisma.client.listen.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!listen) {
      throw new NotFoundException("Listen not found");
    }

    try {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.activityEvent.deleteMany({ where: { listenId: id } });
        await tx.listen.delete({ where: { id } });
      });
    } catch (err) {
      if (!isRecordNotFound(err)) {
        throw err;
      }
      // Lost a delete race: a concurrent deleteListen call (e.g. a
      // double-clicked delete button) already removed this row between our
      // pre-check and this transaction's `tx.listen.delete`. Treat it as
      // already deleted rather than surfacing a raw 500 (judgment-day PR8
      // round 2, issue #1).
    }

    return { id };
  }

  /**
   * Creates or edits the caller's rating for an album (integer 1-10). A first
   * rating also creates a RATING `ActivityEvent`; an edit updates the score in
   * place and keeps that event's `payload.score` snapshot in sync (Decision
   * #10 stores the score on the event for join-free rendering). Returns the
   * album's aggregate so the caller sees the updated mean immediately.
   */
  async rateAlbum(
    clerkUserId: string,
    input: RateAlbumInput,
  ): Promise<RatingResult> {
    const userId = await this.resolveUserId(clerkUserId);
    const albumId = this.validateId(input.albumId, "albumId");
    const score = this.validateScore(input.score);
    await this.assertAlbumExists(albumId);

    const existing = await this.prisma.client.rating.findUnique({
      where: { userId_albumId: { userId, albumId } },
      select: { id: true },
    });

    let rating: { id: string; score: number };
    let created: boolean;
    try {
      const result = await this.prisma.client.$transaction(async (tx) => {
        if (existing) {
          const updated = await tx.rating.update({
            where: { userId_albumId: { userId, albumId } },
            data: { score },
            select: { id: true, score: true },
          });
          await tx.activityEvent.updateMany({
            where: { ratingId: updated.id, type: ActivityType.RATING },
            data: { payload: { score } },
          });
          return { row: updated, created: false };
        }
        const createdRow = await tx.rating.create({
          data: { userId, albumId, score },
          select: { id: true, score: true },
        });
        await tx.activityEvent.create({
          data: {
            userId,
            type: ActivityType.RATING,
            albumId,
            ratingId: createdRow.id,
            payload: { score },
          },
        });
        return { row: createdRow, created: true };
      });
      rating = result.row;
      created = result.created;
    } catch (err) {
      if (isRecordNotFound(err)) {
        // Lost an update race: a concurrent deleteRating call already removed
        // this row between our pre-check and this transaction's
        // `tx.rating.update`. The row is genuinely gone and nothing else will
        // create it, so retry as a create — the caller's intent ("set my
        // rating to X") is still valid (judgment-day PR8 round 3, issue #1).
        try {
          const createdRow = await this.prisma.client.$transaction(async (tx) => {
            const row = await tx.rating.create({
              data: { userId, albumId, score },
              select: { id: true, score: true },
            });
            await tx.activityEvent.create({
              data: {
                userId,
                type: ActivityType.RATING,
                albumId,
                ratingId: row.id,
                payload: { score },
              },
            });
            return row;
          });
          rating = createdRow;
          created = true;
        } catch (retryErr) {
          if (!isUniqueConstraintViolation(retryErr)) {
            throw retryErr;
          }
          // Race within the race-recovery: a second concurrent writer also
          // lost its update to this same delete and reached this retry-create
          // fallback first, so our own retry `tx.rating.create` now collides
          // on the composite PK with the row it just (re)created. That row is
          // authoritative — re-fetch it rather than surfacing a raw 500
          // (judgment-day PR8 round 4, issue #1). Accepted residual risk, not
          // a proven termination: this re-fetch is itself unguarded against a
          // further concurrent delete, same as the sibling P2002 branch below
          // has always been — acceptable for Fase 1's low-concurrency MVP scope.
          rating = await this.prisma.client.rating.findUniqueOrThrow({
            where: { userId_albumId: { userId, albumId } },
            select: { id: true, score: true },
          });
          created = false;
        }
      } else if (isUniqueConstraintViolation(err)) {
        // Lost a create race: a concurrent rateAlbum call for the same
        // (userId, albumId) already inserted the row between our pre-check and
        // this transaction's `tx.rating.create` (composite PK
        // @@id([userId, albumId])). Treat it as this call's own success —
        // re-fetch the now-existing rating rather than surfacing a raw 500
        // (judgment-day PR8 round 2, issue #1).
        rating = await this.prisma.client.rating.findUniqueOrThrow({
          where: { userId_albumId: { userId, albumId } },
          select: { id: true, score: true },
        });
        created = false;
      } else {
        throw err;
      }
    }

    const aggregate = await this.computeAggregate(albumId);
    return { albumId, score: rating.score, aggregate, created };
  }

  /**
   * Deletes the caller's rating for an album.
   *
   * Design Decision #12 (final form): `ActivityEvent.ratingId` is `SetNull`,
   * NOT a DB cascade, so the associated RATING `ActivityEvent` MUST be deleted
   * EXPLICITLY here — otherwise a stranded RATING event with a null `ratingId`
   * would remain in the activity stream. This is a deliberate design choice
   * (app-level cleanup over `onDelete: Cascade`), not something to "simplify".
   *
   * A `Review` has a REQUIRED foreign key to `Rating` on (userId, albumId), so
   * the rating cannot be deleted while its review still exists. The review and
   * its own `ActivityEvent`s are therefore removed first, in the same
   * transaction, before the rating itself.
   */
  async deleteRating(
    clerkUserId: string,
    albumId: unknown,
  ): Promise<DeleteRatingResult> {
    const userId = await this.resolveUserId(clerkUserId);
    const id = this.validateId(albumId, "albumId");

    const rating = await this.prisma.client.rating.findUnique({
      where: { userId_albumId: { userId, albumId: id } },
      select: { id: true },
    });
    if (!rating) {
      throw new NotFoundException("Rating not found");
    }

    try {
      return await this.prisma.client.$transaction(async (tx) => {
        // Decision #12: explicit cleanup of the RATING event (DB only SetNulls).
        const removed = await tx.activityEvent.deleteMany({
          where: { ratingId: rating.id },
        });

        // Schema FK: a review can only exist alongside its rating, so drop it
        // (and its activity events) before the rating is removed.
        const review = await tx.review.findUnique({
          where: { userId_albumId: { userId, albumId: id } },
          select: { id: true },
        });
        let reviewDeleted = false;
        if (review) {
          await tx.activityEvent.deleteMany({
            where: { reviewId: review.id },
          });
          await tx.review.delete({ where: { id: review.id } });
          reviewDeleted = true;
        }

        await tx.rating.delete({
          where: { userId_albumId: { userId, albumId: id } },
        });

        return {
          albumId: id,
          deletedActivityEvents: removed.count,
          reviewDeleted,
        };
      });
    } catch (err) {
      if (!isRecordNotFound(err)) {
        throw err;
      }
      // Lost a delete race: a concurrent deleteRating call (e.g. a
      // double-clicked delete button) already removed this rating (and its
      // review/events, in the review-then-rating order the FK requires)
      // between our pre-check and this transaction's `tx.review.delete` /
      // `tx.rating.delete`. Treat it as already deleted — this call did no
      // additional work — rather than surfacing a raw 500 (judgment-day PR8
      // round 2, issue #1).
      return { albumId: id, deletedActivityEvents: 0, reviewDeleted: false };
    }
  }

  /**
   * Attaches (or edits) the caller's plain-text review for an album. Reviews
   * are plain text only — no rich formatting, replies, likes, or comments
   * (spec: "Basic Text Review" scope boundary). A `Review` requires an existing
   * `Rating` for the same (user, album) — that FK is enforced by the frozen
   * schema, so this rejects a review on an unrated album with a clear 400
   * rather than a raw FK 500. A first review creates a REVIEW `ActivityEvent`;
   * re-submitting updates the body in place without duplicating the event.
   */
  async writeReview(
    clerkUserId: string,
    input: WriteReviewInput,
  ): Promise<ReviewResult> {
    const userId = await this.resolveUserId(clerkUserId);
    const albumId = this.validateId(input.albumId, "albumId");
    const body = this.validateBody(input.body);
    await this.assertAlbumExists(albumId);

    const rating = await this.prisma.client.rating.findUnique({
      where: { userId_albumId: { userId, albumId } },
      select: { id: true },
    });
    if (!rating) {
      throw new BadRequestException("Rate this album before writing a review.");
    }

    const existing = await this.prisma.client.review.findUnique({
      where: { userId_albumId: { userId, albumId } },
      select: { id: true },
    });

    let review: { id: string; body: string };
    let created: boolean;
    try {
      const result = await this.prisma.client.$transaction(async (tx) => {
        if (existing) {
          const updated = await tx.review.update({
            where: { userId_albumId: { userId, albumId } },
            data: { body },
            select: { id: true, body: true },
          });
          return { row: updated, created: false };
        }
        const createdRow = await tx.review.create({
          data: { userId, albumId, body },
          select: { id: true, body: true },
        });
        await tx.activityEvent.create({
          data: {
            userId,
            type: ActivityType.REVIEW,
            albumId,
            reviewId: createdRow.id,
          },
        });
        return { row: createdRow, created: true };
      });
      review = result.row;
      created = result.created;
    } catch (err) {
      if (isRecordNotFound(err)) {
        // Lost an update race: a concurrent deleteRating call (which also
        // deletes the review, per Decision #12's FK-driven cleanup order)
        // already removed this row between our pre-check and this
        // transaction's `tx.review.update`. The row is genuinely gone and
        // nothing else will create it, so retry as a create — the caller's
        // intent ("set my review to X") is still valid (judgment-day PR8
        // round 3, issue #1).
        try {
          const createdRow = await this.prisma.client.$transaction(async (tx) => {
            const row = await tx.review.create({
              data: { userId, albumId, body },
              select: { id: true, body: true },
            });
            await tx.activityEvent.create({
              data: {
                userId,
                type: ActivityType.REVIEW,
                albumId,
                reviewId: row.id,
              },
            });
            return row;
          });
          review = createdRow;
          created = true;
        } catch (retryErr) {
          if (!isUniqueConstraintViolation(retryErr)) {
            throw retryErr;
          }
          // Race within the race-recovery: a second concurrent writer also
          // lost its update to this same delete and reached this retry-create
          // fallback first, so our own retry `tx.review.create` now collides
          // on the composite unique constraint with the row it just
          // (re)created. That row is authoritative — re-fetch it rather than
          // surfacing a raw 500 (judgment-day PR8 round 4, issue #1). Accepted
          // residual risk, not a proven termination: this re-fetch is itself
          // unguarded against a further concurrent delete, same as the
          // sibling P2002 branch below has always been — acceptable for
          // Fase 1's low-concurrency MVP scope.
          review = await this.prisma.client.review.findUniqueOrThrow({
            where: { userId_albumId: { userId, albumId } },
            select: { id: true, body: true },
          });
          created = false;
        }
      } else if (isUniqueConstraintViolation(err)) {
        // Lost a create race: a concurrent writeReview call for the same
        // (userId, albumId) already inserted the row between our pre-check and
        // this transaction's `tx.review.create` (@@unique([userId, albumId])).
        // Treat it as this call's own success — re-fetch the now-existing
        // review rather than surfacing a raw 500 (judgment-day PR8 round 2,
        // issue #1).
        review = await this.prisma.client.review.findUniqueOrThrow({
          where: { userId_albumId: { userId, albumId } },
          select: { id: true, body: true },
        });
        created = false;
      } else {
        throw err;
      }
    }

    return {
      id: review.id,
      albumId,
      body: review.body,
      created,
    };
  }

  /** Resolves the local `User.id` for a Clerk user id, or throws 404. */
  private async resolveUserId(clerkUserId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException("No user found for the current session");
    }
    return user.id;
  }

  /** Verifies the album exists before an FK write, else clean 404. */
  private async assertAlbumExists(albumId: string): Promise<void> {
    const album = await this.prisma.client.album.findUnique({
      where: { id: albumId },
      select: { id: true },
    });
    if (!album) {
      throw new NotFoundException(`Unknown album: ${albumId}`);
    }
  }

  /**
   * Album aggregate rating (mean + count) derived straight from the `Rating`
   * table — the single source of truth, so an edited/deleted rating is always
   * reflected without a denormalized counter to keep in sync.
   */
  private async computeAggregate(albumId: string): Promise<RatingAggregate> {
    const result = await this.prisma.client.rating.aggregate({
      where: { albumId },
      _avg: { score: true },
      _count: { _all: true },
    });
    return {
      average: result._avg.score ?? null,
      count: result._count._all,
    };
  }

  /**
   * Validates an integer score in [MIN_SCORE, MAX_SCORE]. Rejects non-numbers,
   * non-integers, and out-of-range values with the EXACT contract message from
   * design Decision #11 (validated in-service, matching the profile/onboarding
   * convention — the project ships no class-validator/global ValidationPipe).
   */
  private validateScore(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < MIN_SCORE ||
      value > MAX_SCORE
    ) {
      throw new BadRequestException(SCORE_RANGE_ERROR);
    }
    return value;
  }

  /** Validates a UUID-shaped id before it reaches Postgres (clean 400). */
  private validateId(value: unknown, field: string): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException(`${field} must be a valid id.`);
  }

  /** Validates a non-empty plain-text review body. */
  private validateBody(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException("Review body must be a non-empty string.");
    }
    return value.trim();
  }
}
