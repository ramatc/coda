import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller.js";
import { OnboardingService } from "./onboarding.service.js";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";

/**
 * Onboarding module (PR4). Preference capture (genres/artists/albums) plus the
 * onboarding-complete signal that gates the web app. Runs behind the global
 * `ClerkGuard`; `PrismaService` comes from the global PrismaModule.
 *
 * Imports {@link RecommendationsModule} (one-way — recommendations never depend
 * back on onboarding) so completing onboarding can enqueue the first
 * recommendation-generation job via the exported `RecoQueue` (PR11 cold-start
 * trigger).
 */
@Module({
  imports: [RecommendationsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
