import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ProfileModule } from "./profile/profile.module.js";
import { OnboardingModule } from "./onboarding/onboarding.module.js";
import { CatalogImportModule } from "./catalog-import/catalog-import.module.js";
import { SearchModule } from "./search/search.module.js";
import { TrackingModule } from "./tracking/tracking.module.js";
import { ActivityModule } from "./activity/activity.module.js";
import { RecommendationsModule } from "./recommendations/recommendations.module.js";

/**
 * Root module for the Coda API. Fase 1 wires the global PrismaModule (first real
 * `@coda/db` injection) alongside configuration, the health check, the auth
 * layer (global Clerk JWT guard + webhook user sync), the profile module
 * (profile edit + R2 avatar upload), the onboarding module (preference capture +
 * gate), the catalog-import module (Spotify bulk seed — admin trigger + BullMQ
 * producer), the search module (Meilisearch sync + `GET /search`), the tracking
 * module (listen/rating/review + delete paths), the activity module (the
 * personal `GET /me/activity` stream), and the recommendations module (heuristic
 * `Recommendation` generation + `GET /recommendations` / dismiss for `/home`).
 * This is the final Fase 1 MVP slice — all 11 capability modules are now wired.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Read the repo-root .env when running from apps/api (dev/start).
      envFilePath: ["../../.env"],
    }),
    PrismaModule,
    AuthModule,
    ProfileModule,
    OnboardingModule,
    CatalogImportModule,
    SearchModule,
    TrackingModule,
    ActivityModule,
    RecommendationsModule,
    HealthModule,
  ],
})
export class AppModule {}
