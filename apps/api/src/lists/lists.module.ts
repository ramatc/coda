import { Module } from "@nestjs/common";
import { ListsController } from "./lists.controller.js";
import { ListsService } from "./lists.service.js";

/**
 * Curated-list module (Fase 2 slice 2). Owns list CRUD, the ownership /
 * visibility access helpers (403-vs-404 matrix), and the profile Lists section
 * query. Reuses the existing `List`/`ListItem` models as-is (no migration) and
 * stays decoupled from the `want-to-listen` module (a separate backlog domain).
 * Runs behind the global `ClerkGuard`; `PrismaService` comes from the global
 * PrismaModule.
 */
@Module({
  controllers: [ListsController],
  providers: [ListsService],
})
export class ListsModule {}
