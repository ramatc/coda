import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { Public } from "../auth/public.decorator.js";
import { OptionalClerkGuard } from "../auth/optional-clerk.guard.js";
import { ReviewsService, type ReviewDetail } from "./reviews.service.js";

/**
 * Review social endpoints (Fase 2 slice 3). The controller has NO class-level
 * prefix so the routes carry their absolute paths, and all validation and
 * access logic lives in {@link ReviewsService}.
 *
 * - `GET /reviews/:id` → review detail + comments + viewer block (anonymous OK)
 *
 * ## Auth exemption — read before adding a route here
 *
 * `getReview` is the ONLY anonymous-tolerant route in the app. It carries BOTH
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
}
