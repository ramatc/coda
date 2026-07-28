// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

/** The Clerk token `auth()` hands the page for the current test. */
let token: string | null = null;

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn();
const fetchOnboardingStatus = vi.fn();
const resolveOnboardingRedirect = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(token) }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (url: string) => redirect(url),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mocked so the negative assertion below can PROVE the gate never runs, rather
// than merely observing that nothing redirected.
vi.mock("../lib/onboarding", () => ({
  fetchOnboardingStatus: () => fetchOnboardingStatus(),
  resolveOnboardingRedirect: () => resolveOnboardingRedirect(),
}));

const { default: ReviewPage } = await import("../app/reviews/[id]/page");

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

/** The `GET /reviews/:id` payload for a review with no comments yet. */
const REVIEW = {
  id: REVIEW_ID,
  body: "A slow burn that finally clicks on the fourth listen.",
  isSpoiler: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  album: {
    id: "album-1",
    title: "Kid A",
    coverUrl: null,
    primaryArtistName: "Radiohead",
  },
  author: { username: "thom", displayName: "Thom", avatarUrl: null },
  likeCount: 3,
  commentCount: 0,
  comments: [],
  viewer: { hasLiked: false, canInteract: false },
};

/** A JSON `Response` carrying the review payload. */
function reviewResponse(): Response {
  return new Response(JSON.stringify(REVIEW), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` for an unknown review. */
function notFoundResponse(): Response {
  return new Response(JSON.stringify({ statusCode: 404 }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/** The 400 the API's UUID guard raises for a malformed review id. */
function badRequestResponse(): Response {
  return new Response(
    JSON.stringify({
      statusCode: 400,
      message: "review id must be a valid id.",
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/** Renders the async server page for `REVIEW_ID`. */
async function renderPage() {
  render(await ReviewPage({ params: Promise.resolve({ id: REVIEW_ID }) }));
}

/** The headers of the single recorded `fetch` call, as a plain record. */
function headersOf(mock: ReturnType<typeof vi.spyOn>): Record<string, string> {
  const init = (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  token = null;
  notFound.mockClear();
  redirect.mockClear();
  fetchOnboardingStatus.mockClear();
  resolveOnboardingRedirect.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReviewPage", () => {
  it("renders the review for an anonymous visitor, unauthenticated", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reviewResponse());

    await renderPage();

    expect(
      screen.getByText("A slow burn that finally clicks on the fourth listen."),
    ).not.toBeNull();
    // No token → no header at all, so OptionalClerkGuard resolves no viewer and
    // the API answers 200 with the anonymous viewer block.
    expect(headersOf(fetchMock)).not.toHaveProperty("Authorization");
  });

  it("passes a signed-in viewer's token through so the API can resolve them", async () => {
    token = "test-token";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reviewResponse());

    await renderPage();

    expect(headersOf(fetchMock).Authorization).toBe("Bearer test-token");
    expect(screen.getByRole("heading", { name: "Kid A" })).not.toBeNull();
  });

  it("renders the 404 page for an unknown review", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(notFoundResponse());

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("renders the 404 page for a malformed review id, not an error boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(badRequestResponse());

    // This route is PUBLIC, so a truncated or hand-typed link reaches it
    // without ever meeting the Clerk middleware. The API answers 400 for an id
    // that cannot name a review; to the visitor that is the same story as "no
    // such review", so it must land on the 404 page rather than throwing.
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("never runs the onboarding gate, which would bounce anonymous visitors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reviewResponse());

    await renderPage();

    // Every OTHER detail page in the app calls these two before rendering. This
    // route must not: `/reviews/[id]` is anonymously readable, and the gate
    // would redirect a logged-out visitor to `/onboarding`.
    expect(fetchOnboardingStatus).not.toHaveBeenCalled();
    expect(resolveOnboardingRedirect).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
