import { Controller, Get, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  NotificationsService,
  type NotificationPage,
  type UnreadCountResult,
} from "./notifications.service.js";

/**
 * In-app notification endpoints (Fase 2 slice 4). The controller has NO
 * class-level prefix so the routes carry their absolute paths, matching
 * {@link ReviewsController} and `SocialController`; all pagination, validation
 * and mapping live in {@link NotificationsService}.
 *
 * - `GET /notifications`               → one cursor-paginated page + `unreadCount`
 * - `GET /notifications/unread-count`  → `{ unreadCount }`, the polled badge
 *
 * The split is deliberate (design Decision 12): every signed-in tab hits the
 * count route twice a minute forever, so it must stay a single indexed `count`
 * with a ~20-byte response rather than a 20-item join. The LIST response carries
 * `unreadCount` too, so opening the dropdown reconciles the badge in the same
 * round-trip with no third request and no flicker.
 *
 * ## Auth — read before adding a route here
 *
 * Every handler stays behind the plain fail-closed global `ClerkGuard`. There is
 * **no `@Public()` and no `OptionalClerkGuard` anywhere in this module**, at
 * method OR class level, and that is not an oversight to "fix": a notification
 * is PRIVATE to its recipient, so unlike `GET /reviews/:id` there is no
 * anonymous view of this data to serve. An anonymous-tolerant read here would
 * hand `@CurrentUser("sub")` an `undefined` caller instead of returning 401.
 * `notifications.controller.spec.ts` asserts that placement.
 *
 * ## Route order
 *
 * Both routes are STATIC segments and there is no `:id` sibling in v1, so there
 * is no shadowing hazard today. If per-item read is ever added, declare
 * `notifications/:id/...` AFTER both handlers below — otherwise `unread-count`
 * matches as an `:id`.
 */
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The caller's own notifications, most recent first (cursor paginated). */
  @Get("notifications")
  list(
    @CurrentUser("sub") clerkUserId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<NotificationPage> {
    return this.notifications.list(clerkUserId, { cursor, limit });
  }

  /** The caller's unread total — the endpoint the web app's 30s loop polls. */
  @Get("notifications/unread-count")
  getUnreadCount(
    @CurrentUser("sub") clerkUserId: string,
  ): Promise<UnreadCountResult> {
    return this.notifications.getUnreadCount(clerkUserId);
  }
}
