"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { fetchUnreadCount } from "../../lib/notifications";

/**
 * How often the bell re-reads the unread count while the tab is visible. One
 * named constant so the value is a single edit away and directly assertable.
 */
export const POLL_INTERVAL_MS = 30_000;

/** What {@link useNotificationPoll} hands the bell. */
export interface NotificationPoll {
  /** The last known unread total (`0` until the first poll lands). */
  unreadCount: number;
  /**
   * Overrides the count locally — e.g. `0` right after `read-all`, or the
   * `unreadCount` that rode along with the list. Later polls use it as their
   * failure fallback, so an override is never undone by a failed tick.
   */
  setUnreadCount: (count: number) => void;
}

/**
 * Polls `GET /notifications/unread-count` for the bell badge (client). The
 * mechanics are where the bugs live, so each one is deliberate:
 *
 * - Polls immediately on mount, then every {@link POLL_INTERVAL_MS}.
 * - `visibilitychange → hidden` clears the interval; `→ visible` polls
 *   IMMEDIATELY and only then restarts the interval. Without the immediate
 *   poll a user returning to the tab stares at a badge up to 30s stale.
 * - An `inFlight` ref skips a tick while a request is pending, so a hung
 *   request under repeated hide/show cycles cannot stack overlapping fetches
 *   (same synchronous-ref rationale as `useAsyncAction`'s `running` ref).
 * - Failure is SILENT: the last known count is kept and no error UI renders.
 * - Unmount removes BOTH the interval and the listener.
 *
 * The token is read per poll through Clerk's `getToken()` (which caches and
 * refreshes), the same way the follow and like islands authenticate.
 */
export function useNotificationPoll(): NotificationPoll {
  const { getToken } = useAuth();
  const [unreadCount, setCount] = useState(0);

  // Mirrors `unreadCount` for the poll loop, which runs outside render and must
  // not be re-created (and re-poll) every time the count changes.
  const lastKnown = useRef(0);
  const inFlight = useRef(false);
  // Read through a ref so the effect below mounts exactly once even if a
  // provider ever hands out a new `getToken` identity per render.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const setUnreadCount = useCallback((count: number) => {
    lastKnown.current = count;
    setCount(count);
  }, []);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let unmounted = false;

    async function poll(): Promise<void> {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        const token = await getTokenRef.current();
        const next = await fetchUnreadCount(token, lastKnown.current);
        if (!unmounted) {
          lastKnown.current = next;
          setCount(next);
        }
      } catch {
        // Silent by design: keep the last known count, render no error.
      } finally {
        inFlight.current = false;
      }
    }

    function startInterval(): void {
      if (intervalId === null) {
        intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    function stopInterval(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        stopInterval();
        return;
      }
      void poll();
      startInterval();
    }

    if (document.visibilityState !== "hidden") {
      void poll();
      startInterval();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unmounted = true;
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return { unreadCount, setUnreadCount };
}
