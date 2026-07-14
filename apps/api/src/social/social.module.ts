import { Module } from "@nestjs/common";
import { SocialController } from "./social.controller.js";
import { SocialService } from "./social.service.js";

/**
 * Social-graph module (Fase 2 slice 1). Exposes follow/unfollow and the
 * follower/following counts surfaced on a profile:
 *   - `POST/DELETE /users/:username/follow`
 *   - `GET /users/:username/social`
 *
 * It reuses the dormant `Follow` model as-is (no migration) and stays decoupled
 * from the `profile` module (which owns identity only) — the social graph is a
 * social-module concern, mirroring how `activity` keeps its own `UUID_PATTERN`.
 * The followed-activity feed (`GET /feed`) lands in a follow-up slice. Runs
 * behind the global `ClerkGuard`; `PrismaService` comes from the global
 * PrismaModule.
 */
@Module({
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}
