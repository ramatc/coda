import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

/**
 * Health module. The DB-backed readiness probe injects the global
 * {@link PrismaService} (provided by the global PrismaModule), so this module no
 * longer wires the raw `@coda/db` singleton itself — Fase 0's provider-ready-
 * but-unused scaffold is now superseded by the real PrismaService (Decision #3).
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
