import { Module } from "@nestjs/common";
import { WantToListenController } from "./want-to-listen.controller.js";
import { WantToListenService } from "./want-to-listen.service.js";

/**
 * Want-to-listen module (Fase 2 slice 2). Owns the manual backlog: mark/unmark
 * an album and the public profile "Quiero escuchar" section, whose read
 * anti-joins the rows against the user's Listens/Ratings (read-time
 * auto-resolve). Decoupled from the `lists` module on purpose — a backlog is a
 * different domain from a curated list (no ordering, no visibility flags).
 * Reuses the additive `WantToListen` model. Runs behind the global `ClerkGuard`;
 * `PrismaService` comes from the global PrismaModule.
 */
@Module({
  controllers: [WantToListenController],
  providers: [WantToListenService],
})
export class WantToListenModule {}
