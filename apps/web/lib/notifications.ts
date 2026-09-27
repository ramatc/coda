import { getApiBaseUrl } from "./api-client";

/** The two notification kinds v1 produces. Mirrors the API's `NotificationType`. */
export type NotificationType = "FOLLOW" | "COMMENT";

/**
 * The user whose action produced a notification. Always present (the FK is
 * required and cascades), but its FIELDS degrade to `""`/`null` when the actor
 * has no `Profile` yet — so an empty `username` is a real, reachable value that
 * link builders must not interpolate into `/u/{username}`.
 */
export interface NotificationActor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** One entry in the caller's notification list. Mirrors the API's `NotificationItem`. */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp of when this was read, or `null` while it is still unread. */
  readAt: string | null;
  actor: NotificationActor;
  /** The review a COMMENT notification links at; `null` for every FOLLOW row. */
  reviewId: string | null;
  /** The first 140 characters of the comment body (COMMENT only), else `null`. */
  commentExcerpt: string | null;
}

/** One cursor-paginated page of notifications plus the caller's unread total. */
export interface NotificationPage {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

/** Auth header for a (possibly missing) Clerk token, matching `lib/social.ts`. */
function authHeaders(token: string | null): Record<string, string> {
  return { Authorization: `Bearer ${token ?? ""}` };
}

/**
 * The caller's unread total from `GET /notifications/unread-count` — the ONLY
 * request the bell's 30s poll makes (design Decision 12). A network failure or
 * non-OK response fails safe to `fallback` (default `0`) rather than throwing,
 * so a badge can never break the page. The poll hook passes its last known
 * count as the fallback, which is what makes a failed tick a silent no-op
 * instead of a badge that flickers to zero whenever the API blips.
 */
export async function fetchUnreadCount(
  token: string | null,
  fallback = 0,
): Promise<number> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/notifications/unread-count`,
      { headers: authHeaders(token), cache: "no-store" },
    );
    if (!response.ok) {
      return fallback;
    }
    const body = (await response.json()) as { unreadCount: number };
    return body.unreadCount;
  } catch {
    return fallback;
  }
}

/**
 * The first page of the caller's notifications from `GET /notifications`,
 * fetched only when the dropdown opens — never on a poll tick. Unlike
 * {@link fetchUnreadCount} it THROWS on a non-OK response or a network failure
 * instead of degrading to an empty page: the dropdown must tell a real failure
 * apart from a genuinely empty inbox, so it can (a) surface an error instead of
 * hanging on "Loading..." forever, and (b) skip `markAllRead` when the list
 * never actually loaded.
 */
export async function fetchNotifications(
  token: string | null,
): Promise<NotificationPage> {
  const response = await fetch(`${getApiBaseUrl()}/notifications`, {
    headers: authHeaders(token),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Could not load notifications.");
  }
  return (await response.json()) as NotificationPage;
}

/**
 * Marks every unread notification as read (`POST /notifications/read-all`),
 * fired when the dropdown opens. Like {@link fetchNotifications} it THROWS on
 * failure, so the island can surface the error instead of pretending the badge
 * cleared.
 * The endpoint is idempotent server-side (a second call is a 200 no-op).
 */
export async function markAllRead(token: string | null): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/notifications/read-all`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error("Could not mark notifications as read.");
  }
}
