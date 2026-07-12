import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  ActivityService,
  type ActivityPage,
} from "./activity.service.js";

/**
 * Personal activity-stream endpoint (PR10), behind the global {@link ClerkGuard}.
 * `GET /me/activity` returns the caller's OWN `ActivityEvent`s (listens,
 * ratings, reviews) in reverse-chronological order, cursor paginated. It is
 * deliberately mounted at `/me/activity`, NOT `/feed` — `/feed` is reserved for
 * the Fase 2 social feed of followed users' activity, so shipping the personal
 * stream under its own path avoids a breaking rename later (spec: "Own-Activity
 * Stream"). `@CurrentUser("sub")` yields the verified Clerk user id used to
 * scope the query to the caller alone; no other user's activity is ever returned.
 */
@Controller("me")
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  /** The caller's own activity, most recent first (cursor paginated). */
  @Get("activity")
  getOwnActivity(
    @CurrentUser("sub") clerkUserId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<ActivityPage> {
    return this.activity.getOwnActivity(clerkUserId, { cursor, limit });
  }
}
