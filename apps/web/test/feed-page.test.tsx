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

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  usePathname: () => "/feed",
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

const { default: FeedPage } = await import("../app/feed/page");

/** A JSON `Response` with the given body. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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

/** Routes `/feed` and the shell's `/profile` read by URL. */
function mockFetch(items: unknown[] = [FEED_ITEM]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profile")) {
        return Promise.resolve(
          jsonResponse({ userId: "user-1", username: "mati" }),
        );
      }
      if (url.includes("/feed")) {
        return Promise.resolve(jsonResponse({ items, nextCursor: null }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
}

async function renderPage() {
  render(await FeedPage({ searchParams: Promise.resolve({}) }));
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

describe("FeedPage", () => {
  it("renders the feed inside the shared shell (Header + BottomNav)", async () => {
    mockFetch();

    await renderPage();

    expect(screen.getByText("CODA")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Primary" })).not.toBeNull();
    expect(screen.getByText(/Alfredo 2/)).not.toBeNull();
  });

  it("runs the onboarding gate and bounces a half-onboarded viewer", async () => {
    resolveOnboardingRedirect.mockReturnValue("/onboarding");
    mockFetch();

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });
});
