import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "./health/health.module.js";

/**
 * Root module for the Coda API. Fase 0 wires only configuration and the health
 * check — no domain features yet.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Read the repo-root .env when running from apps/api (dev/start).
      envFilePath: ["../../.env"],
    }),
    HealthModule,
  ],
})
export class AppModule {}
