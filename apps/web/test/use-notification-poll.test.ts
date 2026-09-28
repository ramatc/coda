// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { fetchUnreadCount } from "../lib/notifications";

// ONE stable `getToken` across renders, as Clerk's own is. A fresh function per
// render would make any effect keyed on it re-run and hide a real stacking bug.
const getToken = vi.fn();
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken }),
}));

vi.mock("../lib/notifications", () => ({
  fetchUnreadCount: vi.fn(),
}));

const { POLL_INTERVAL_MS, useNotificationPoll } = await import(
  "../app/_shell/use-notification-poll"
);

const fetchCount = vi.mocked(fetchUnreadCount);

/** What `document.visibilityState` reports for the current test. */
let visibility: DocumentVisibilityState = "visible";

/** Flips the tab's visibility and fires the event the hook listens for. */
async function setVisibility(next: DocumentVisibilityState): Promise<void> {
  visibility = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

/** Advances fake time and flushes the promise chain of any tick it fires. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mounts the hook and lets the mount-time poll settle. */
async function mount() {
  const hook = renderHook(() => useNotificationPoll());
  await act(async () => {
    await Promise.resolve();
  });
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  getToken.mockReset().mockResolvedValue("test-token");
  fetchCount.mockReset().mockResolvedValue(3);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNotificationPoll", () => {
  it("exports the poll interval as a named 30s constant", () => {
    expect(POLL_INTERVAL_MS).toBe(30_000);
  });

  it("polls immediately on mount and exposes the fetched count", async () => {
    const { result } = await mount();

    expect(fetchCount).toHaveBeenCalledTimes(1);
    expect(fetchCount).toHaveBeenCalledWith("test-token", 0);
    expect(result.current.unreadCount).toBe(3);
  });

  it("polls again on every interval tick and tracks the new count", async () => {
    const { result } = await mount();
    fetchCount.mockResolvedValue(5);

    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenCalledTimes(2);
    expect(result.current.unreadCount).toBe(5);

    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenCalledTimes(3);
  });

  it("does not poll at mount while the tab is already hidden", async () => {
    visibility = "hidden";
    await mount();

    await advance(POLL_INTERVAL_MS * 3);
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("clears the interval when the tab becomes hidden", async () => {
    await mount();
    expect(fetchCount).toHaveBeenCalledTimes(1);

    await setVisibility("hidden");
    await advance(POLL_INTERVAL_MS * 3);

    expect(fetchCount).toHaveBeenCalledTimes(1);
  });

  it("polls immediately on becoming visible, THEN restarts the interval", async () => {
    const { result } = await mount();
    await setVisibility("hidden");
    fetchCount.mockResolvedValue(8);

    await setVisibility("visible");
    // Immediate: no timer advanced, yet a second request already went out.
    expect(fetchCount).toHaveBeenCalledTimes(2);
    expect(result.current.unreadCount).toBe(8);

    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenCalledTimes(3);
  });

  it("removes both the interval and the listener on unmount", async () => {
    const { unmount } = await mount();
    unmount();

    await advance(POLL_INTERVAL_MS * 3);
    await setVisibility("hidden");
    await setVisibility("visible");

    expect(fetchCount).toHaveBeenCalledTimes(1);
  });

  it("skips overlapping ticks while a request is still in flight", async () => {
    await mount();
    let release: (count: number) => void = () => undefined;
    fetchCount.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    await advance(POLL_INTERVAL_MS); // starts the hung request
    await advance(POLL_INTERVAL_MS * 2); // two ticks land while it hangs
    expect(fetchCount).toHaveBeenCalledTimes(2);

    await act(async () => {
      release(4);
      await Promise.resolve();
    });
    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenCalledTimes(3);
  });

  it("fails silently and keeps the last known count", async () => {
    const { result } = await mount();
    expect(result.current.unreadCount).toBe(3);

    // A token failure throws before the fetch layer's own fallback applies.
    getToken.mockRejectedValueOnce(new Error("session expired"));
    await advance(POLL_INTERVAL_MS);
    expect(result.current.unreadCount).toBe(3);

    // A fetch-layer failure resolves to the fallback the hook passed in.
    fetchCount.mockImplementationOnce((_token, fallback) =>
      Promise.resolve(fallback ?? 0),
    );
    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenLastCalledWith("test-token", 3);
    expect(result.current.unreadCount).toBe(3);
  });

  it("lets the caller override the count, which later polls use as their fallback", async () => {
    const { result } = await mount();

    act(() => {
      result.current.setUnreadCount(0);
    });
    expect(result.current.unreadCount).toBe(0);

    await advance(POLL_INTERVAL_MS);
    expect(fetchCount).toHaveBeenLastCalledWith("test-token", 0);
  });

  it("drops a poll that resolves after a local override superseded it", async () => {
    const { result } = await mount();
    let release: (count: number) => void = () => undefined;
    fetchCount.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );

    await advance(POLL_INTERVAL_MS); // starts the still-pending poll

    // read-all (or similar) overrides the count locally WHILE that poll hangs.
    act(() => {
      result.current.setUnreadCount(0);
    });
    expect(result.current.unreadCount).toBe(0);

    // The stale poll now resolves with the pre-override count: it must not
    // resurrect the badge back to 5.
    await act(async () => {
      release(5);
      await Promise.resolve();
    });
    expect(result.current.unreadCount).toBe(0);

    // A later poll (started after the override) still applies normally.
    fetchCount.mockResolvedValueOnce(7);
    await advance(POLL_INTERVAL_MS);
    expect(result.current.unreadCount).toBe(7);
  });
});
