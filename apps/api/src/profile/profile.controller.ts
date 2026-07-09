import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  AvatarService,
  type AvatarPresignResult,
} from "./avatar.service.js";
import {
  ProfileService,
  type ProfileResponse,
  type PublicProfileResponse,
  type UpdateProfileInput,
} from "./profile.service.js";

/**
 * Profile endpoints, all behind the global {@link ClerkGuard} (no per-route
 * guard needed — Fase 1 protects every route by default). `@CurrentUser("sub")`
 * yields the verified Clerk user id, which the service maps to the local
 * `User`/`Profile` row.
 */
@Controller("profile")
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly avatars: AvatarService,
  ) {}

  /** The authenticated user's own profile. */
  @Get()
  getOwn(
    @CurrentUser("sub") clerkUserId: string,
  ): Promise<ProfileResponse> {
    return this.profiles.getOwnProfile(clerkUserId);
  }

  /** Edit the authenticated user's own profile (username, displayName, bio, avatarUrl). */
  @Patch()
  update(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: UpdateProfileInput,
  ): Promise<ProfileResponse> {
    return this.profiles.updateOwnProfile(clerkUserId, body);
  }

  /**
   * Mints a presigned direct-to-R2 upload URL for a new avatar. The client PUTs
   * the bytes to `uploadUrl`, then calls `PATCH /profile` with the returned
   * `publicUrl` to persist it.
   */
  @Post("avatar-url")
  async createAvatarUpload(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: { contentType?: unknown; size?: unknown },
  ): Promise<AvatarPresignResult> {
    const userId = await this.profiles.resolveUserId(clerkUserId);
    return this.avatars.createAvatarUpload(userId, {
      contentType: String(body?.contentType ?? ""),
      size: Number(body?.size),
    });
  }

  /** A profile viewed by username (powers the `/u/[username]` page). */
  @Get(":username")
  getByUsername(
    @Param("username") username: string,
  ): Promise<PublicProfileResponse> {
    return this.profiles.getByUsername(username);
  }
}
