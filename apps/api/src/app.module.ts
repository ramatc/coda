import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ProfileModule } from "./profile/profile.module.js";
import { OnboardingModule } from "./onboarding/onboarding.module.js";
import { CatalogImportModule } from "./catalog-import/catalog-import.module.js";

/**
 * Root module for the Coda API. Fase 1 wires the global PrismaModule (first real
 * `@coda/db` injection) alongside configuration, the health check, the auth
 * layer (global Clerk JWT guard + webhook user sync), the profile module
 * (profile edit + R2 avatar upload), the onboarding module (preference capture +
 * gate), and the catalog-import module (Spotify bulk seed — admin trigger +
 * BullMQ producer). Remaining domain feature modules land in later PR slices.
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
    HealthModule,
  ],
})
export class AppModule {}
