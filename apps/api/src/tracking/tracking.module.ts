import { Module } from "@nestjs/common";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";
import { AlbumsController } from "./albums.controller.js";
import { AlbumDetailService } from "./album-detail.service.js";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";

/**
 * Album-tracking module (PR8 + PR9). The write side (PR8) — listen / rating /
 * review writes plus the listen and rating delete paths — persists each write
 * and its `ActivityEvent` in one Prisma transaction. The read side (PR9) —
 * `GET /albums/:id` — returns the album detail (metadata + tracklist +
 * aggregate rating + the current viewer's tracking state) in a single response
 * for the album detail page. Runs behind the global `ClerkGuard`;
 * `PrismaService` comes from the global PrismaModule.
 */
@Module({
  imports: [RecommendationsModule],
  controllers: [TrackingController, AlbumsController],
  providers: [TrackingService, AlbumDetailService],
})
export class TrackingModule {}
