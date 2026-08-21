import { Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
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
 * - `GET  /notifications`               → one cursor-paginated page + `unreadCount`
 * - `GET  /notifications/unread-count`  → `{ unreadCount }`, the polled badge
 * - `POST /notifications/read-all`      → `{ unreadCount: 0 }`, fired on open
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
 * All three routes are STATIC segments and there is no `:id` sibling in v1, so
 * there is no shadowing hazard today. If per-item read is ever added, declare
 * `notifications/:id/...` AFTER all three handlers below — otherwise
 * `unread-count` and `read-all` match as an `:id`.
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

  /**
   * Marks all of the caller's unread notifications as read — what the web
   * dropdown fires when it OPENS (design Decision 13). Takes no body and no
   * params: the authenticated caller fully determines the scope.
   *
   * `200`, not Nest's default `201`, because nothing is created and the call is
   * idempotent — the response reports the resulting badge state, matching the
   * follow/unfollow and like/dismiss convention in this codebase.
   */
  @Post("notifications/read-all")
  @HttpCode(200)
  markAllRead(
    @CurrentUser("sub") clerkUserId: string,
  ): Promise<UnreadCountResult> {
    return this.notifications.markAllRead(clerkUserId);
  }
}
