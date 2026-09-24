// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

/** The Clerk token `auth()` hands the page for the current test. */
let token: string | null = "test-token";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const fetchOnboardingStatus = vi.fn();
const resolveOnboardingRedirect = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(token) }),
}));

// The Recommendations island's own Clerk/router surface.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  useRouter: () => ({ refresh: vi.fn() }),
  // Read by the shell's BottomNav for active-link highlighting; the exact
  // path isn't asserted on by these tests, so a fixed value is enough.
  usePathname: () => "/home",
}));

vi.mock("../lib/onboarding", () => ({
  fetchOnboardingStatus: () => fetchOnboardingStatus(),
  resolveOnboardingRedirect: (...args: unknown[]) =>
    resolveOnboardingRedirect(...args),
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

const { default: HomePage } = await import("../app/home/page");

/** A JSON `Response` with the given body. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const POPULAR_ALBUM = {
  id: "album-1",
  title: "Rodeo",
  coverUrl: null,
  primaryArtistName: "Travis Scott",
};

const FEED_ITEM = {
  id: "feed-1",
  type: "RATING",
  occurredAt: "2026-09-01T00:00:00.000Z",
  album: {
    id: "album-2",
    title: "Alfredo 2",
    coverUrl: null,
    primaryArtistName: "Freddie Gibbs & The Alchemist",
  },
  score: 9.1,
  reviewBody: null,
  reviewId: null,
  reviewLikeCount: null,
  reviewCommentCount: null,
  actor: { username: "mati", displayName: "Mati", avatarUrl: null },
};

/**
 * Routes the page's parallel reads by URL — `/search/popular`, `/feed`,
 * `/recommendations`, `/me/activity` (the viewer's own log, for the sidebar),
 * plus `/profile` (read by the {@link AppShell} wrapper to resolve the
 * viewer's own username for the shell's "You" link) — each independently
 * overridable so a test can isolate one section without hand-building every
 * payload every time.
 */
function mockFetch(
  overrides: {
    popular?: unknown[];
    feed?: { items: unknown[]; nextCursor: string | null };
    recommendations?: unknown[];
    activity?: { items: unknown[]; nextCursor: string | null };
  } = {},
) {
  const popular = overrides.popular ?? [POPULAR_ALBUM];
  const feed = overrides.feed ?? { items: [FEED_ITEM], nextCursor: null };
  const recommendations = overrides.recommendations ?? [];
  const activity = overrides.activity ?? { items: [], nextCursor: null };

  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profile")) {
        return Promise.resolve(
          jsonResponse({ userId: "user-1", username: "mati" }),
        );
      }
      if (url.includes("/search/popular")) {
        return Promise.resolve(jsonResponse(popular));
      }
      if (url.includes("/me/activity")) {
        return Promise.resolve(jsonResponse(activity));
      }
      if (url.includes("/feed")) {
        return Promise.resolve(jsonResponse(feed));
      }
      if (url.includes("/recommendations")) {
        return Promise.resolve(jsonResponse(recommendations));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
}

/** Renders the async server page. */
async function renderPage() {
  render(await HomePage());
}

beforeEach(() => {
  token = "test-token";
  redirect.mockClear();
  fetchOnboardingStatus.mockClear().mockResolvedValue({ complete: true });
  resolveOnboardingRedirect.mockClear().mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("HomePage", () => {
  it("renders the three dashboard sections, not an activity timeline", async () => {
    mockFetch();

    await renderPage();

    expect(screen.getByRole("heading", { name: "Popular" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "New from friends" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "For your ears" }),
    ).not.toBeNull();
  });

  it("shows a popular album from the discover endpoint", async () => {
    mockFetch({ popular: [POPULAR_ALBUM] });

    await renderPage();

    expect(screen.getByText("Rodeo")).not.toBeNull();
  });

  it("shows a small friends-activity preview linking to the full feed", async () => {
    mockFetch({ feed: { items: [FEED_ITEM], nextCursor: null } });

    await renderPage();

    expect(screen.getByText(/Alfredo 2/)).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "View all activity →" }),
    ).toHaveProperty("href", expect.stringContaining("/feed"));
  });

  it("caps the friends preview instead of listing the whole feed page", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      ...FEED_ITEM,
      id: `feed-${i}`,
      album: { ...FEED_ITEM.album, id: `album-${i}`, title: `Album ${i}` },
    }));
    mockFetch({ feed: { items, nextCursor: null } });

    await renderPage();

    expect(screen.getAllByTestId("friends-preview-cover-placeholder")).toHaveLength(3);
  });

  it("runs the onboarding gate and bounces a half-onboarded viewer", async () => {
    resolveOnboardingRedirect.mockReturnValue("/onboarding");
    mockFetch();

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });
});
