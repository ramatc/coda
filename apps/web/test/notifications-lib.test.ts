import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllRead,
  type NotificationPage,
} from "../lib/notifications";

const PAGE: NotificationPage = {
  items: [
    {
      id: "n-1",
      type: "COMMENT",
      createdAt: "2026-09-01T00:00:00.000Z",
      readAt: null,
      actor: { username: "ada", displayName: "Ada", avatarUrl: null },
      reviewId: "review-1",
      commentExcerpt: "Great take on the second side.",
    },
    {
      id: "n-2",
      type: "FOLLOW",
      createdAt: "2026-08-31T00:00:00.000Z",
      readAt: "2026-08-31T12:00:00.000Z",
      actor: { username: "grace", displayName: "Grace", avatarUrl: null },
      reviewId: null,
      commentExcerpt: null,
    },
  ],
  nextCursor: null,
  unreadCount: 1,
};

/** A JSON `Response` with the given body and status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The URL and init of the `index`-th recorded `fetch` call. */
function call(
  fetchMock: { mock: { calls: unknown[][] } },
  index = 0,
): { url: string; init: RequestInit | undefined } {
  const [input, init] = fetchMock.mock.calls[index] ?? [];
  return { url: String(input), init: init as RequestInit | undefined };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchUnreadCount", () => {
  it("returns the unread count from the polled endpoint with the bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ unreadCount: 7 }));

    expect(await fetchUnreadCount("test-token")).toBe(7);

    const { url, init } = call(fetchMock);
    expect(url).toMatch(/\/notifications\/unread-count$/);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(init?.cache).toBe("no-store");
  });

  it("degrades to 0 on a non-OK response, even one with a parseable body", async () => {
    // A JSON body on purpose: the `ok` check, not a parse failure, must decide.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ unreadCount: 5 }, 500),
    );

    expect(await fetchUnreadCount("test-token")).toBe(0);
  });

  it("degrades to 0 on a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchUnreadCount(null)).toBe(0);
  });

  it("degrades to the caller's fallback instead of 0 when one is given", async () => {
    // The poll hook passes its last known count, so a failed tick changes nothing.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ unreadCount: 9 }, 502))
      .mockRejectedValueOnce(new Error("offline"));

    expect(await fetchUnreadCount("test-token", 4)).toBe(4);
    expect(await fetchUnreadCount("test-token", 6)).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores the fallback on a successful response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ unreadCount: 0 }),
    );

    expect(await fetchUnreadCount("test-token", 4)).toBe(0);
  });
});

describe("fetchNotifications", () => {
  it("returns the page from GET /notifications with the bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(PAGE));

    expect(await fetchNotifications("test-token")).toEqual(PAGE);

    const { url, init } = call(fetchMock);
    expect(url).toMatch(/\/notifications$/);
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("degrades to an empty page on a non-OK response, even one with a parseable body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(PAGE, 401));

    expect(await fetchNotifications("test-token")).toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it("degrades to an empty page on a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchNotifications(null)).toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });
});

describe("markAllRead", () => {
  it("POSTs to /notifications/read-all with the bearer token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ unreadCount: 0 }));

    await markAllRead("test-token");

    const { url, init } = call(fetchMock);
    expect(url).toMatch(/\/notifications\/read-all$/);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  it("throws on a non-OK response so the island can surface it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 503 }),
    );

    await expect(markAllRead("test-token")).rejects.toThrow(
      "Could not mark notifications as read.",
    );
  });

  it("propagates a network failure instead of swallowing it", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(markAllRead("test-token")).rejects.toThrow("offline");
  });
});
