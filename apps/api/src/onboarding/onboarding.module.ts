import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller.js";
import { OnboardingService } from "./onboarding.service.js";

/**
 * Onboarding module (PR4). Preference capture (genres/artists/albums) plus the
 * onboarding-complete signal that gates the web app. Runs behind the global
 * `ClerkGuard`; `PrismaService` comes from the global PrismaModule.
 */
@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
