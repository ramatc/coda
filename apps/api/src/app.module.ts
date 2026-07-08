import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module.js";
import { HealthModule } from "./health/health.module.js";

/**
 * Root module for the Coda API. Fase 1 wires the global PrismaModule (first real
 * `@coda/db` injection) alongside configuration and the health check. Domain
 * feature modules land in later PR slices.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Read the repo-root .env when running from apps/api (dev/start).
      envFilePath: ["../../.env"],
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
