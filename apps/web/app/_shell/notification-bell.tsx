"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { cn } from "@coda/ui";
import {
  fetchNotifications,
  markAllRead,
  type NotificationItem,
} from "../../lib/notifications";
import { useNotificationPoll } from "./use-notification-poll";

/** Link target when an item has nothing more specific to point at. */
const ROOT_HREF = "/";

/**
 * Where a notification links. FOLLOW → the actor's profile, COMMENT → the
 * review the comment was left on. Pure, so the fallback rules are testable
 * without rendering.
 *
 * An actor with no `Profile` arrives with `username: ""` (the API degrades the
 * actor's fields rather than dropping the row). Interpolating that would build
 * a broken `/u/` link, so it falls back to the app root instead — the same
 * fallback class the email worker applies to its `APP_URL`-based deep link.
 */
export function notificationHref(item: NotificationItem): string {
  if (item.type === "FOLLOW") {
    return item.actor.username
      ? `/u/${encodeURIComponent(item.actor.username)}`
      : ROOT_HREF;
  }
  return item.reviewId
    ? `/reviews/${encodeURIComponent(item.reviewId)}`
    : ROOT_HREF;
}

/** "Ada followed you" / "Ada commented on your review", degrading the name. */
function notificationText(item: NotificationItem): string {
  const who = item.actor.displayName || item.actor.username || "Someone";
  return item.type === "FOLLOW"
    ? `${who} followed you`
    : `${who} commented on your review`;
}

/** Badge copy: exact up to 99, then capped so the pill never overflows. */
function badgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * Notification bell + dropdown for the authenticated header (client island).
 *
 * - The badge comes from {@link useNotificationPoll} — the 30s count poll,
 *   paused while the tab is hidden. The full list is NEVER polled.
 * - Opening the dropdown fetches the list (lazily: nothing is requested before
 *   the first open, and each open re-reads it so it is never stale), THEN
 *   fires `read-all`. The order matters: the list is snapshotted first, and the
 *   ids that were unread at that moment stay highlighted until the dropdown
 *   closes (design Decision 13) — otherwise every item would visibly
 *   de-highlight the instant it opened.
 * - A failed `read-all` is surfaced inline and the badge keeps the list's own
 *   count, rather than pretending the notifications were cleared.
 * - Escape or a click outside closes it.
 *
 * Only mounted inside `Header`, which only renders inside `AppShell` on
 * authenticated routes — so signed-out visitors never start the poll.
 */
export function NotificationBell() {
  const { getToken } = useAuth();
  const { unreadCount, setUnreadCount } = useNotificationPoll();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  function close(): void {
    setOpen(false);
    setHighlighted(new Set());
    setError(null);
  }

  // Escape and click-outside only need listening while the dropdown is open.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    function onMouseDown(event: MouseEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  async function openDropdown(): Promise<void> {
    setOpen(true);
    setError(null);

    const token = await getToken();
    const page = await fetchNotifications(token);
    setItems(page.items);
    setHighlighted(
      new Set(
        page.items.filter((item) => item.readAt === null).map((item) => item.id),
      ),
    );
    // The list's own count reconciles the badge in the same round-trip.
    setUnreadCount(page.unreadCount);

    try {
      await markAllRead(token);
      setUnreadCount(0);
    } catch {
      setError("Could not mark notifications as read.");
    }
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    void openDropdown();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="true"
        className="relative flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-surface-1 hover:text-text-primary"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            data-testid="notification-badge"
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-coda px-1 text-[10px] font-semibold leading-none text-white"
          >
            {badgeLabel(unreadCount)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 top-full z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-card border border-border-subtle bg-surface-1 shadow-lg"
        >
          <p className="border-b border-border-subtle px-4 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Notifications
          </p>
          {error ? (
            <p className="px-4 py-2 text-sm text-red-600" role="alert">
              {error}
            </p>
          ) : null}
          {items === null ? (
            <p className="px-4 py-6 text-sm text-text-secondary">Loading...</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-secondary">
              No notifications yet.
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((item) => {
                const isNew = highlighted.has(item.id);
                return (
                  <li key={item.id}>
                    <Link
                      href={notificationHref(item)}
                      onClick={close}
                      className={cn(
                        "flex flex-col gap-1 border-b border-border-subtle px-4 py-3 text-sm last:border-b-0 hover:bg-surface-2",
                        isNew && "bg-coda-subtle",
                      )}
                    >
                      <span className="flex items-center gap-2 text-text-primary">
                        {isNew ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full bg-coda"
                            />
                            <span className="sr-only">New</span>
                          </>
                        ) : null}
                        {notificationText(item)}
                      </span>
                      {item.commentExcerpt ? (
                        <span className="line-clamp-2 text-xs text-text-secondary">
                          {item.commentExcerpt}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
