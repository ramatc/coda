// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  fetchNotificationsOrThrow,
  fetchUnreadCount,
  markAllRead,
  type NotificationItem,
  type NotificationPage,
} from "../lib/notifications";

// Hoisted so the mock factory below (itself hoisted by Vitest) can close over
// it, and so tests can control what a given `getToken()` call resolves/rejects
// with instead of getting a fresh, unreachable `vi.fn()` on every render.
const mockGetToken = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Only the network layer is stubbed; the REAL poll hook drives the badge, so
// these tests exercise the same count path production does.
vi.mock("../lib/notifications", () => ({
  fetchUnreadCount: vi.fn(),
  fetchNotificationsOrThrow: vi.fn(),
  markAllRead: vi.fn(),
}));

const { NotificationBell, notificationHref } = await import(
  "../app/_shell/notification-bell"
);

const COMMENT_UNREAD: NotificationItem = {
  id: "n-1",
  type: "COMMENT",
  createdAt: "2026-09-01T00:00:00.000Z",
  readAt: null,
  actor: { username: "ada", displayName: "Ada", avatarUrl: null },
  reviewId: "review-1",
  commentExcerpt: "Great take on the second side.",
};

const FOLLOW_READ: NotificationItem = {
  id: "n-2",
  type: "FOLLOW",
  createdAt: "2026-08-31T00:00:00.000Z",
  readAt: "2026-08-31T12:00:00.000Z",
  actor: { username: "grace", displayName: "Grace", avatarUrl: null },
  reviewId: null,
  commentExcerpt: null,
};

/** A FOLLOW from an actor with no `Profile`: the API degrades fields to `""`. */
const FOLLOW_NO_PROFILE: NotificationItem = {
  id: "n-3",
  type: "FOLLOW",
  createdAt: "2026-08-30T00:00:00.000Z",
  readAt: null,
  actor: { username: "", displayName: "", avatarUrl: null },
  reviewId: null,
  commentExcerpt: null,
};

function page(items: NotificationItem[]): NotificationPage {
  return {
    items,
    nextCursor: null,
    unreadCount: items.filter((item) => item.readAt === null).length,
  };
}

/** The bell's toggle button, whatever its current count label says. */
function bellButton(): HTMLElement {
  return screen.getByRole("button", { name: /Notifications/ });
}

/** Renders the bell and waits for the mount-time poll to land. */
async function renderBell() {
  render(
    <div>
      <NotificationBell />
      <p>Outside the bell</p>
    </div>,
  );
  await waitFor(() => expect(fetchUnreadCount).toHaveBeenCalled());
}

/** Opens the dropdown and waits for the list to render. */
async function openDropdown(): Promise<HTMLElement> {
  fireEvent.click(bellButton());
  const region = await screen.findByRole("region", { name: "Notifications" });
  await waitFor(() => expect(markAllRead).toHaveBeenCalled());
  return region;
}

beforeEach(() => {
  mockGetToken.mockReset().mockResolvedValue("test-token");
  vi.mocked(fetchUnreadCount).mockReset().mockResolvedValue(2);
  vi.mocked(fetchNotificationsOrThrow)
    .mockReset()
    .mockResolvedValue(page([COMMENT_UNREAD, FOLLOW_READ]));
  vi.mocked(markAllRead).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("notificationHref", () => {
  it("links a FOLLOW at the actor's profile", () => {
    expect(notificationHref(FOLLOW_READ)).toBe("/u/grace");
  });

  it("links a COMMENT at the review it was left on", () => {
    expect(notificationHref(COMMENT_UNREAD)).toBe("/reviews/review-1");
  });

  it("falls back to the app root for a FOLLOW whose actor has no profile", () => {
    // Never `/u/` — an empty username would build a broken profile link.
    expect(notificationHref(FOLLOW_NO_PROFILE)).toBe("/");
  });

  it("falls back to the app root for a COMMENT with no review to link at", () => {
    expect(notificationHref({ ...COMMENT_UNREAD, reviewId: null })).toBe("/");
  });
});

describe("NotificationBell", () => {
  it("shows the unread badge when the polled count is above zero", async () => {
    await renderBell();

    expect(await screen.findByTestId("notification-badge")).toHaveProperty(
      "textContent",
      "2",
    );
    expect(bellButton().getAttribute("aria-label")).toBe(
      "Notifications, 2 unread",
    );
  });

  it("hides the badge when there is nothing unread", async () => {
    vi.mocked(fetchUnreadCount).mockResolvedValue(0);
    await renderBell();

    expect(screen.queryByTestId("notification-badge")).toBeNull();
    expect(bellButton().getAttribute("aria-label")).toBe("Notifications");
  });

  it("loads the list lazily: nothing is fetched until the dropdown opens", async () => {
    await renderBell();

    expect(fetchNotificationsOrThrow).not.toHaveBeenCalled();
    expect(markAllRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("opening fires markAllRead exactly once and clears the badge", async () => {
    await renderBell();
    await screen.findByTestId("notification-badge");

    const region = await openDropdown();

    expect(fetchNotificationsOrThrow).toHaveBeenCalledTimes(1);
    expect(markAllRead).toHaveBeenCalledTimes(1);
    expect(markAllRead).toHaveBeenCalledWith("test-token");
    await waitFor(() =>
      expect(screen.queryByTestId("notification-badge")).toBeNull(),
    );
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps the pre-open unread items highlighted until the dropdown closes", async () => {
    await renderBell();
    const region = await openDropdown();

    const [comment, follow] = within(region).getAllByRole("listitem");
    // read-all has already resolved, yet the snapshot still marks n-1 as new.
    expect(within(comment!).getByText("New")).toBeTruthy();
    expect(within(follow!).queryByText("New")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    vi.mocked(fetchNotificationsOrThrow).mockResolvedValue(
      page([{ ...COMMENT_UNREAD, readAt: "2026-09-02T00:00:00.000Z" }]),
    );
    const reopened = await openDropdown();

    await waitFor(() =>
      expect(within(reopened).getAllByRole("listitem")).toHaveLength(1),
    );
    expect(within(reopened).queryByText("New")).toBeNull();
  });

  it("renders who did what, linking each item at its target", async () => {
    vi.mocked(fetchNotificationsOrThrow).mockResolvedValue(
      page([COMMENT_UNREAD, FOLLOW_READ, FOLLOW_NO_PROFILE]),
    );
    await renderBell();
    const region = await openDropdown();

    const links = within(region).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/reviews/review-1",
      "/u/grace",
      "/",
    ]);
    expect(links[0]!.textContent).toContain("Ada commented on your review");
    expect(links[0]!.textContent).toContain("Great take on the second side.");
    expect(links[1]!.textContent).toContain("Grace followed you");
    expect(links[2]!.textContent).toContain("Someone followed you");
  });

  it("shows an empty state when there are no notifications", async () => {
    vi.mocked(fetchNotificationsOrThrow).mockResolvedValue(page([]));
    await renderBell();
    const region = await openDropdown();

    expect(within(region).getByText("No notifications yet.")).toBeTruthy();
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("closes on Escape", async () => {
    await renderBell();
    await openDropdown();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    expect(bellButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a click outside, but not on a click inside", async () => {
    await renderBell();
    const region = await openDropdown();

    fireEvent.mouseDown(region);
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByText("Outside the bell"));
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("surfaces a failed read-all and keeps the badge at the list's count", async () => {
    vi.mocked(markAllRead).mockRejectedValue(new Error("boom"));
    await renderBell();
    await openDropdown();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not mark notifications as read.",
    );
    expect(screen.getByTestId("notification-badge").textContent).toBe("1");
  });

  it("surfaces an error instead of hanging on Loading forever when getToken rejects", async () => {
    await renderBell();
    await screen.findByTestId("notification-badge");
    // Only the dropdown's own getToken() call rejects — the poll's mount-time
    // call above already resolved and must stay unaffected.
    mockGetToken.mockRejectedValueOnce(new Error("token unavailable"));

    fireEvent.click(bellButton());
    const region = await screen.findByRole("region", { name: "Notifications" });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load notifications.",
    );
    expect(within(region).queryByText("Loading...")).toBeNull();
    expect(fetchNotificationsOrThrow).not.toHaveBeenCalled();
    expect(markAllRead).not.toHaveBeenCalled();
  });

  it("does not mark all read when the list fails to load, and keeps the badge", async () => {
    vi.mocked(fetchNotificationsOrThrow).mockRejectedValue(new Error("offline"));
    await renderBell();
    await screen.findByTestId("notification-badge");

    fireEvent.click(bellButton());
    const region = await screen.findByRole("region", { name: "Notifications" });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load notifications.",
    );
    expect(within(region).queryByText("Loading...")).toBeNull();
    expect(markAllRead).not.toHaveBeenCalled();
    expect(screen.getByTestId("notification-badge").textContent).toBe("2");
  });

  it("ignores a stale response from an open superseded by a close + reopen", async () => {
    await renderBell();

    let resolveFirst!: (value: NotificationPage) => void;
    const firstResponse = new Promise<NotificationPage>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(fetchNotificationsOrThrow).mockReturnValueOnce(firstResponse);

    // Open #1: the request is sent but never resolves yet.
    fireEvent.click(bellButton());
    await waitFor(() =>
      expect(fetchNotificationsOrThrow).toHaveBeenCalledTimes(1),
    );

    // Close before it settles, then reopen: this is the request that should win.
    fireEvent.keyDown(document, { key: "Escape" });
    vi.mocked(fetchNotificationsOrThrow).mockResolvedValueOnce(
      page([FOLLOW_READ]),
    );
    fireEvent.click(bellButton());
    const region = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(markAllRead).toHaveBeenCalledTimes(1));
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);

    // The stale first request finally resolves — it must not overwrite the
    // second (current) open's items, highlighted set, or unread count.
    resolveFirst(page([COMMENT_UNREAD, FOLLOW_READ]));
    await Promise.resolve();
    await Promise.resolve();

    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(markAllRead).toHaveBeenCalledTimes(1);
  });
});
