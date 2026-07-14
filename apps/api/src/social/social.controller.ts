import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  SocialService,
  type FollowResult,
  type SocialStats,
} from "./social.service.js";

/**
 * Social-graph endpoints (Fase 2 slice 1), all behind the global {@link ClerkGuard}.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service maps
 * to the local `User.id`. The `:username` path param identifies the target
 * profile.
 *
 * - `POST   /users/:username/follow`  → follow (idempotent, `200`)
 * - `DELETE /users/:username/follow`  → unfollow (idempotent, `200`)
 * - `GET    /users/:username/social`  → follower/following counts + `isFollowing`
 *
 * Follow/unfollow are `200` (not `201`/`204`) because they are idempotent — the
 * response reports the resulting follow state, matching the listens/dismiss
 * convention. This controller is thin: all validation and graph logic lives in
 * {@link SocialService}.
 */
@Controller("users")
export class SocialController {
  constructor(private readonly social: SocialService) {}

  /** Follows `:username` on behalf of the caller. */
  @Post(":username/follow")
  @HttpCode(200)
  follow(
    @CurrentUser("sub") clerkUserId: string,
    @Param("username") username: string,
  ): Promise<FollowResult> {
    return this.social.follow(clerkUserId, username);
  }

  /** Unfollows `:username` on behalf of the caller. */
  @Delete(":username/follow")
  @HttpCode(200)
  unfollow(
    @CurrentUser("sub") clerkUserId: string,
    @Param("username") username: string,
  ): Promise<FollowResult> {
    return this.social.unfollow(clerkUserId, username);
  }

  /** Follower/following counts for `:username`, plus the caller's follow state. */
  @Get(":username/social")
  getSocialStats(
    @CurrentUser("sub") clerkUserId: string,
    @Param("username") username: string,
  ): Promise<SocialStats> {
    return this.social.getSocialStats(clerkUserId, username);
  }
}
