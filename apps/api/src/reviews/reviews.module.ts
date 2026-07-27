import { Module } from "@nestjs/common";
import { OptionalClerkGuard } from "../auth/optional-clerk.guard.js";
import { ReviewsController } from "./reviews.controller.js";
import { ReviewsService } from "./reviews.service.js";

/**
 * Review social module (Fase 2 slice 3). Owns the `reviewId`-keyed resource
 * family: the anonymously-readable review detail and (from the write-path
 * slice) likes plus comment CRUD. Kept separate from `tracking` — the
 * `albumId`-keyed write surface — so the app's only auth exemption lives in a
 * controller whose sole anonymous-tolerant method is the read. `PrismaService`
 * comes from the global PrismaModule.
 *
 * `OptionalClerkGuard` is listed in `providers` as a deliberate
 * explicitness/discoverability choice, NOT a DI requirement: its inherited
 * dependencies (`Reflector` from `@nestjs/core`, `ConfigService` from the global
 * `ConfigModule`) are globally resolvable, so Nest would instantiate it from the
 * bare `@UseGuards(OptionalClerkGuard)` class reference either way — exactly as
 * it does for `CatalogAdminGuard`, which is absent from
 * `CatalogImportModule.providers`. The entry is what anchors the guard's
 * "provided ONLY here, never as `APP_GUARD`" scoping claim to a greppable line.
 */
@Module({
  controllers: [ReviewsController],
  providers: [ReviewsService, OptionalClerkGuard],
})
export class ReviewsModule {}
