import { Module } from "@nestjs/common";
import { ActivityController } from "./activity.controller.js";
import { ActivityService } from "./activity.service.js";

/**
 * Personal activity-stream module (PR10). Exposes `GET /me/activity` — the
 * authenticated user's own `ActivityEvent`s (listens/ratings/reviews) in
 * reverse-chronological order, cursor paginated. Read-only: it reads the events
 * the tracking module (PR8) writes; it never fans out to other users' activity
 * (the `Follow` model stays unused — spec "No Social Fan-Out"). Runs behind the
 * global `ClerkGuard`; `PrismaService` comes from the global PrismaModule.
 */
@Module({
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
