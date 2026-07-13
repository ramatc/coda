import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { RecommendationStatus } from "@coda/db";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  RecommendationsService,
  type RecommendationItem,
} from "./recommendations.service.js";

/**
 * Recommendations endpoints (PR11), behind the global {@link ClerkGuard}.
 *
 * - `GET /recommendations` → the caller's own `ACTIVE` recommendations for
 *   `/home`, strongest first (heuristically generated from onboarding
 *   preferences + tracked taste weighted by popularity — no embeddings).
 * - `POST /recommendations/:id/dismiss` → dismisses one recommendation so it is
 *   excluded from future generation runs.
 *
 * `@CurrentUser("sub")` yields the verified Clerk user id used to scope every
 * query to the caller alone.
 */
@Controller("recommendations")
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /** The caller's active recommendations, strongest score first. */
  @Get()
  getRecommendations(
    @CurrentUser("sub") clerkUserId: string,
  ): Promise<RecommendationItem[]> {
    return this.recommendations.getRecommendations(clerkUserId);
  }

  /** Dismisses one of the caller's recommendations (excluded from future runs). */
  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<{ id: string; status: RecommendationStatus }> {
    return this.recommendations.dismiss(clerkUserId, id);
  }
}
