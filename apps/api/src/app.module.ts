import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";

/**
 * Root module for the Coda API. Fase 1 wires the global PrismaModule (first real
 * `@coda/db` injection) alongside configuration, the health check, and the auth
 * layer (global Clerk JWT guard + webhook user sync). Domain feature modules
 * land in later PR slices.
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
    HealthModule,
  ],
})
export class AppModule {}
