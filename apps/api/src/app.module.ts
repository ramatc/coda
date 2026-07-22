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
import { SocialModule } from "./social/social.module.js";
import { ListsModule } from "./lists/lists.module.js";

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
 * Fase 1 wired all 11 MVP capability modules; Fase 2 slice 1 adds the social
 * module (follow/unfollow + follower/following counts on a profile). Fase 2
 * slice 2 adds the lists module (curated-list CRUD + profile Lists section).
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
    SocialModule,
    ListsModule,
    HealthModule,
  ],
})
export class AppModule {}
