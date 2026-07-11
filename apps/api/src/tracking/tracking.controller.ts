import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  TrackingService,
  type DeleteRatingResult,
  type ListenResult,
  type RateAlbumInput,
  type RatingResult,
  type ReviewResult,
  type WriteReviewInput,
} from "./tracking.service.js";

/**
 * Album-tracking endpoints (PR8), all behind the global {@link ClerkGuard}.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`, so a caller can only mutate their own tracking
 * data. Deletes explicitly clean up the associated `ActivityEvent` rows (the
 * FKs are `SetNull`, not cascade — design Decision #12).
 *
 * No reply/like/comment routes exist here: reviews are plain text only, with no
 * social affordances (spec "Basic Text Review" scope boundary, task 8.3/8.5).
 */
@Controller()
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  /**
   * Marks an album as listened. `200` (not `201`) because it is idempotent —
   * re-marking returns the existing listen rather than creating a duplicate.
   */
  @Post("listens")
  @HttpCode(200)
  markListened(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: { albumId?: unknown },
  ): Promise<ListenResult> {
    return this.tracking.markListened(clerkUserId, body?.albumId);
  }

  /** Deletes one of the caller's listens (and its activity events). */
  @Delete("listens/:id")
  @HttpCode(200)
  deleteListen(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<{ id: string }> {
    return this.tracking.deleteListen(clerkUserId, id);
  }

  /**
   * Creates or edits the caller's rating (integer 1-10). `PUT` because it is an
   * idempotent "set my rating" operation keyed on (user, album).
   */
  @Put("ratings")
  @HttpCode(200)
  rateAlbum(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: RateAlbumInput,
  ): Promise<RatingResult> {
    return this.tracking.rateAlbum(clerkUserId, body);
  }

  /**
   * Deletes the caller's rating for an album, explicitly cleaning up the
   * associated RATING `ActivityEvent` (and any review) in the same transaction.
   */
  @Delete("ratings/:albumId")
  @HttpCode(200)
  deleteRating(
    @CurrentUser("sub") clerkUserId: string,
    @Param("albumId") albumId: string,
  ): Promise<DeleteRatingResult> {
    return this.tracking.deleteRating(clerkUserId, albumId);
  }

  /** Attaches (or edits) the caller's plain-text review for an album. */
  @Post("reviews")
  @HttpCode(200)
  writeReview(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: WriteReviewInput,
  ): Promise<ReviewResult> {
    return this.tracking.writeReview(clerkUserId, body);
  }
}
