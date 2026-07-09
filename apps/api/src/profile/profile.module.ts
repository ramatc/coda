import { Module } from "@nestjs/common";
import { ProfileController } from "./profile.controller.js";
import { ProfileService } from "./profile.service.js";
import { AvatarService } from "./avatar.service.js";

/**
 * Profile module (PR3). Own-profile read/edit plus R2 avatar presigning. Runs
 * behind the global `ClerkGuard` from the auth module; `PrismaService` and
 * `ConfigService` come from their global modules.
 */
@Module({
  controllers: [ProfileController],
  providers: [ProfileService, AvatarService],
})
export class ProfileModule {}
