// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

/** The Clerk token `auth()` hands the page for the current test. */
let token: string | null = "test-token";

// Throws like the real `redirect()` does, so a test that expects the
// onboarding gate to bounce proves the page STOPPED there rather than merely
// called it.
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
}));

// Mocked so the assertions below can PROVE the gate ran, rather than merely
// observing that nothing redirected. `/lists` is protected, so a
// half-onboarded viewer belongs at `/onboarding`, not here.
vi.mock("../lib/onboarding", () => ({
  fetchOnboardingStatus: () => fetchOnboardingStatus(),
  resolveOnboardingRedirect: (...args: unknown[]) =>
    resolveOnboardingRedirect(...args),
}));

// Every prop other than `href` is forwarded, so `ListsSection`'s links (and
// its empty-state "Create your first list" link) survive into the DOM.
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

const { default: ListsPage } = await import("../app/lists/page");

const USERNAME = "mati";

/** A JSON `Response` for `GET /profile`, resolving the viewer's username. */
function profileResponse(): Response {
  return new Response(
    JSON.stringify({ userId: "user-1", username: USERNAME }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** A JSON `Response` for `GET /users/:username/lists`. */
function listsResponse(lists: unknown[]): Response {
  return new Response(JSON.stringify(lists), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes the page's two reads by URL — `fetchViewerOwnLists` chains
 * `GET /profile` into `GET /users/:username/lists` — so a single blanket
 * mock can't serve both.
 */
function mockFetch(lists: unknown[] = []) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profile")) {
        return Promise.resolve(profileResponse());
      }
      if (url.includes(`/users/${USERNAME}/lists`)) {
        return Promise.resolve(listsResponse(lists));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
}

/** Renders the async server page. */
async function renderPage() {
  render(await ListsPage());
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

describe("ListsPage", () => {
  it("renders the viewer's own lists", async () => {
    mockFetch([
      {
        id: "list-1",
        title: "Deep cuts",
        description: null,
        isRanked: true,
        isPublic: true,
        itemCount: 3,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ]);

    await renderPage();

    expect(screen.getByRole("link", { name: "Deep cuts" })).not.toBeNull();
  });

  it("runs the onboarding gate and bounces a half-onboarded viewer", async () => {
    resolveOnboardingRedirect.mockReturnValue("/onboarding");
    mockFetch();

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");

    // The gate must run BEFORE the reads, so a bounced viewer never triggers
    // the profile/lists fetches.
    expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("asks the gate to return to /lists after onboarding", async () => {
    mockFetch();

    await renderPage();

    expect(resolveOnboardingRedirect).toHaveBeenCalledWith(
      { complete: true },
      "/lists",
    );
  });

  it("shows the owner's create-a-list empty state when there are no lists yet", async () => {
    mockFetch([]);

    await renderPage();

    expect(
      screen.getByRole("link", { name: "Create your first list" }),
    ).not.toBeNull();
  });
});
