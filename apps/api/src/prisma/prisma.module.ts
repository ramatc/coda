import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

/**
 * Global module exposing the shared {@link PrismaService}. Marked `@Global` so
 * every feature module can inject `PrismaService` without re-importing this
 * module. This is the first real wiring of `@coda/db` into the API — Fase 0 left
 * the client provider-ready but unused (Decision #3).
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
