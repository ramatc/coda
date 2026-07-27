import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { Public } from "../auth/public.decorator.js";
import { OptionalClerkGuard } from "../auth/optional-clerk.guard.js";
import {
  ReviewsService,
  type CommentInput,
  type ReviewCommentView,
  type ReviewDetail,
  type ReviewLikeResult,
} from "./reviews.service.js";

/**
 * Review social endpoints (Fase 2 slice 3). The controller has NO class-level
 * prefix so the routes carry their absolute paths, and all validation and
 * access logic lives in {@link ReviewsService}.
 *
 * - `GET    /reviews/:id`                      → detail + comments + viewer (anonymous OK)
 * - `POST   /reviews/:id/like`                 → like (`200`; duplicate → `409`)
 * - `DELETE /reviews/:id/like`                 → unlike (`200`, tolerant)
 * - `POST   /reviews/:id/comments`             → add a comment (`201`)
 * - `PATCH  /reviews/:id/comments/:commentId`  → edit own comment (author only)
 * - `DELETE /reviews/:id/comments/:commentId`  → delete own comment (`204`)
 *
 * ## Auth exemption — read before adding a route here
 *
 * `getReview` is the ONLY anonymous-tolerant route in the app; every write below
 * it stays behind the plain fail-closed global `ClerkGuard`. It carries BOTH
 * decorators, and both are METHOD-level on purpose:
 *
 * - `@Public()` tells the global fail-closed `ClerkGuard` not to reject a
 *   caller with no token.
 * - `@UseGuards(OptionalClerkGuard)` still resolves the caller when they DID
 *   present a valid token — without it, `@CurrentUser("sub")` would be
 *   `undefined` even for a signed-in user (the global guard returns early on
 *   `@Public()` before parsing the Authorization header), so every signed-in
 *   visitor would be served the anonymous viewer block and dead like/comment
 *   CTAs.
 *
 * NEITHER decorator may move to the class: `ClerkGuard` resolves them with
 * `getAllAndOverride([handler, class])`, so a class-level `@Public()` would
 * silently exempt every write endpoint added here later, and a class-level
 * `OptionalClerkGuard` would additionally downgrade those writes to
 * anonymous-tolerant. `reviews.controller.spec.ts` asserts this placement.
 */
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /**
   * Reads a single review with its album, author, counts, comments and the
   * caller's viewer block. `clerkUserId` is `undefined` for an anonymous caller
   * AND for one whose token failed verification — both are served the same
   * anonymous payload, never a 401.
   */
  @Public()
  @UseGuards(OptionalClerkGuard)
  @Get("reviews/:id")
  getReview(
    @CurrentUser("sub") clerkUserId: string | undefined,
    @Param("id") id: string,
  ): Promise<ReviewDetail> {
    return this.reviews.getReview(clerkUserId, id);
  }

  /**
   * Likes a review. `200` rather than `201` because the payload is a counter
   * projection, not a created-resource representation. A duplicate is a `409`.
   */
  @Post("reviews/:id/like")
  @HttpCode(200)
  likeReview(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<ReviewLikeResult> {
    return this.reviews.likeReview(clerkUserId, id);
  }

  /** Removes the caller's like. Tolerant: unliking what was never liked is a `200`. */
  @Delete("reviews/:id/like")
  @HttpCode(200)
  unlikeReview(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<ReviewLikeResult> {
    return this.reviews.unlikeReview(clerkUserId, id);
  }

  /** Adds a plain-text comment (≤500 chars) to a review. */
  @Post("reviews/:id/comments")
  createComment(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Body() body: CommentInput,
  ): Promise<ReviewCommentView> {
    return this.reviews.createComment(clerkUserId, id, body);
  }

  /** Edits the caller's own comment (non-author → `403`, wrong review → `404`). */
  @Patch("reviews/:id/comments/:commentId")
  updateComment(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Param("commentId") commentId: string,
    @Body() body: CommentInput,
  ): Promise<ReviewCommentView> {
    return this.reviews.updateComment(clerkUserId, id, commentId, body);
  }

  /** Deletes the caller's own comment (non-author → `403`, wrong review → `404`). */
  @Delete("reviews/:id/comments/:commentId")
  @HttpCode(204)
  deleteComment(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Param("commentId") commentId: string,
  ): Promise<void> {
    return this.reviews.deleteComment(clerkUserId, id, commentId);
  }
}
