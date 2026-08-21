import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

/**
 * In-app notifications module (Fase 2 slice 4). Owns the notification read
 * surface — `GET /notifications` and `GET /notifications/unread-count` — and,
 * from the hook-site slice on, the write helpers (`notifyFollow` /
 * `notifyComment`) the social and reviews modules call. `PrismaService` comes
 * from the global PrismaModule.
 *
 * `exports: [NotificationsService]` is the load-bearing line: `SocialModule` and
 * `ReviewsModule` import THIS module to inject the service at their hook sites.
 * Which is exactly why this module `imports` nothing — the dependency runs one
 * way (social/reviews → notifications) and nothing here reaches back, so the
 * graph stays acyclic by construction. Adding an import of a feature module here
 * would close that cycle and fail at bootstrap.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
