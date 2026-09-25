// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { PopularAlbum } from "../lib/search";
import type { PopularReview } from "../lib/reviews";
import type { PopularList } from "../lib/lists";

/**
 * Tripwires: the public landing must never resolve a session or redirect, so
 * signed-in and anonymous visitors get the same page. The Clerk mocks answer
 * as a signed-in viewer; if the page (or anything it composes) ever calls
 * them, or calls `redirect`, the tests below fail.
 */
const clerkAuth = vi.fn(() =>
  Promise.resolve({
    userId: "user-1",
    getToken: () => Promise.resolve("real-token"),
  }),
);
const clerkUseAuth = vi.fn();
const redirect = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => clerkAuth(),
  currentUser: () => clerkAuth(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => clerkUseAuth(),
  useUser: () => clerkUseAuth(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
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

const { default: LandingPage } = await import("../app/page");

const ALBUMS: PopularAlbum[] = [
  {
    id: "album-1",
    title: "Rodeo",
    coverUrl: null,
    primaryArtistName: "Travis Scott",
  },
];

const REVIEWS: PopularReview[] = [
  {
    id: "review-1",
    body: "A slow burn that finally clicks on the fourth listen.",
    isSpoiler: false,
    score: 9,
    createdAt: "2026-07-01T00:00:00.000Z",
    album: {
      id: "album-2",
      title: "Kid A",
      coverUrl: null,
      primaryArtistName: "Radiohead",
    },
    author: { username: "thom", displayName: "Thom", avatarUrl: null },
    likeCount: 3,
    commentCount: 1,
  },
];

const LISTS: PopularList[] = [
  {
    id: "list-1",
    title: "Best of 2026",
    description: null,
    isRanked: true,
    itemCount: 12,
    likeCount: 5,
    createdAt: "2026-07-01T00:00:00.000Z",
    owner: { username: "ada", displayName: "Ada", avatarUrl: null },
    previewCovers: [],
  },
];

/** The popular-content endpoints the landing reads, in fetch order. */
const ENDPOINTS = ["/search/popular", "/reviews/popular", "/lists/popular"];

/** The labelled sections inside `<main>`, in document order. */
const SECTION_NAMES = [
  "Your after-hours music archive.",
  "Everything your listening deserves",
  "Trending tonight",
  "Popular reviews",
  "Popular lists",
  "Built for the records that stay with you after dark.",
  "Start your archive tonight.",
];

/** A JSON `Response` with the given body. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes the page's three parallel reads by URL. Each payload is
 * independently overridable; `"fail"` makes that endpoint reject, the way an
 * unreachable API does.
 */
function mockFetch(
  overrides: {
    albums?: unknown[] | "fail";
    reviews?: unknown[] | "fail";
    lists?: unknown[] | "fail";
  } = {},
) {
  const bodies: Record<string, unknown[] | "fail"> = {
    "/search/popular": overrides.albums ?? ALBUMS,
    "/reviews/popular": overrides.reviews ?? REVIEWS,
    "/lists/popular": overrides.lists ?? LISTS,
  };

  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const endpoint = ENDPOINTS.find((path) => url.includes(path));
      const body = endpoint ? bodies[endpoint] : undefined;
      if (body === undefined || body === "fail") {
        return Promise.reject(new Error(`fetch failed: ${url}`));
      }
      return Promise.resolve(jsonResponse(body));
    });
}

/** Renders the async server page the way Next does: await, then render. */
async function renderPage() {
  render(await LandingPage());
}

/** A labelled landing section, located by its visible heading. */
function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

beforeEach(() => {
  clerkAuth.mockClear();
  clerkUseAuth.mockClear();
  redirect.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LandingPage", () => {
  it("composes every section, in order, inside the public shell", async () => {
    mockFetch();
    await renderPage();

    const main = screen.getByRole("main");
    const regions = within(main).getAllByRole("region");
    expect(regions).toHaveLength(SECTION_NAMES.length);
    SECTION_NAMES.forEach((name, index) => {
      expect(regions[index]).toBe(section(name));
    });

    // Header before the content, footer after it, one landmark each.
    const banner = screen.getByRole("banner");
    const footer = screen.getByRole("contentinfo");
    expect(
      banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps the anchor ids the public nav links to", async () => {
    mockFetch();
    await renderPage();

    expect(section("Everything your listening deserves").id).toBe("features");
    expect(section("Trending tonight").id).toBe("trending");
    expect(section("Popular reviews").id).toBe("reviews");
    expect(section("Popular lists").id).toBe("lists");
  });

  it("renders live data from the three popular-content endpoints", async () => {
    mockFetch();
    await renderPage();

    const trending = section("Trending tonight");
    expect(within(trending).getByText("Rodeo")).toBeTruthy();
    expect(within(trending).getByText("Travis Scott")).toBeTruthy();

    const reviews = section("Popular reviews");
    expect(
      within(reviews).getByRole("link", { name: "Kid A" }).getAttribute("href"),
    ).toBe("/reviews/review-1");
    expect(within(reviews).getByLabelText("Rating 9.0 out of 10")).toBeTruthy();

    const lists = section("Popular lists");
    expect(
      within(lists)
        .getByRole("link", { name: "Best of 2026" })
        .getAttribute("href"),
    ).toBe("/lists/list-1");
  });

  it("reads each endpoint once, anonymously, and never resolves a session", async () => {
    const fetchSpy = mockFetch();
    await renderPage();

    const urls = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(urls).toHaveLength(ENDPOINTS.length);
    for (const endpoint of ENDPOINTS) {
      expect(urls.filter((url) => url.includes(endpoint))).toHaveLength(1);
    }

    // No request carries a viewer token: the header is absent or a bare
    // `Bearer ` (which `Headers` normalizes to `Bearer`).
    const authorizations = fetchSpy.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("authorization"),
    );
    expect(authorizations).toHaveLength(ENDPOINTS.length);
    for (const authorization of authorizations) {
      expect(authorization ?? "Bearer").toBe("Bearer");
    }

    // Signed in or not, the page never asks Clerk and never redirects.
    expect(clerkAuth).not.toHaveBeenCalled();
    expect(clerkUseAuth).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("still renders every section with empty states when the API is unreachable", async () => {
    mockFetch({ albums: "fail", reviews: "fail", lists: "fail" });
    await renderPage();

    expect(
      within(screen.getByRole("main")).getAllByRole("region"),
    ).toHaveLength(SECTION_NAMES.length);
    expect(
      within(section("Trending tonight")).getByText(
        /Nothing is trending yet\./,
      ),
    ).toBeTruthy();
    expect(
      within(section("Popular reviews")).getByText(/No reviews to show yet\./),
    ).toBeTruthy();
    expect(
      within(section("Popular lists")).getByText(/No public lists yet\./),
    ).toBeTruthy();
  });

  it("isolates one failing endpoint from the other sections", async () => {
    mockFetch({ reviews: "fail" });
    await renderPage();

    expect(
      within(section("Popular reviews")).getByText(/No reviews to show yet\./),
    ).toBeTruthy();
    expect(within(section("Trending tonight")).getByText("Rodeo")).toBeTruthy();
    expect(
      within(section("Popular lists")).getByRole("link", {
        name: "Best of 2026",
      }),
    ).toBeTruthy();
  });
});
