import { Module } from "@nestjs/common";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";

/**
 * Album-tracking module (PR8). Listen / rating / review writes plus the
 * listen and rating delete paths, each write and its `ActivityEvent` persisted
 * in one Prisma transaction. Runs behind the global `ClerkGuard`;
 * `PrismaService` comes from the global PrismaModule.
 */
@Module({
  controllers: [TrackingController],
  providers: [TrackingService],
})
export class TrackingModule {}
