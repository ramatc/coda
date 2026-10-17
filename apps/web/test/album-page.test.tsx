// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

/** The Clerk token `auth()` hands the page for the current test. */
let token: string | null = "test-token";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const fetchOnboardingStatus = vi.fn();
const resolveOnboardingRedirect = vi.fn();
const fetchViewerOwnLists = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(token) }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (url: string) => redirect(url),
}));

// Carries `forceRedirectUrl` into the DOM so the anonymous branch can prove
// where it sends the visitor back to.
vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({
    children,
    forceRedirectUrl,
  }: {
    children: ReactNode;
    forceRedirectUrl?: string;
  }) => (
    <span
      data-testid="clerk-sign-in-button"
      data-force-redirect-url={forceRedirectUrl}
    >
      {children}
    </span>
  ),
}));

vi.mock("../lib/onboarding", () => ({
  fetchOnboardingStatus: () => fetchOnboardingStatus(),
  resolveOnboardingRedirect: (...args: unknown[]) =>
    resolveOnboardingRedirect(...args),
}));

vi.mock("../lib/lists", () => ({
  fetchViewerOwnLists: (...args: unknown[]) => fetchViewerOwnLists(...args),
}));

// The shell and the action island have their own tests; doubles here make this
// file about COMPOSITION: which wrapper and which island the page mounts.
vi.mock("../app/_shell/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) =>
    Promise.resolve(<div data-testid="app-shell">{children}</div>),
}));
vi.mock("../app/albums/[id]/album-actions", () => ({
  AlbumActions: () => <div data-testid="album-actions" />,
}));

const { default: AlbumPage, generateMetadata } =
  await import("../app/albums/[id]/page");

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

const ALBUM = {
  id: ALBUM_ID,
  title: "OK Computer",
  coverUrl: null,
  releaseDate: "1997-06-16",
  releaseYear: 1997,
  trackCount: 12,
  primaryArtist: { id: "artist-1", name: "Radiohead" },
  genres: [],
  tracks: [],
  aggregateRating: { average: 9, count: 1 },
  viewer: {
    listened: false,
    listenId: null,
    score: null,
    review: null,
    resolved: false,
    wantToListenId: null,
  },
};

function mockFetch(status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify(status === 200 ? ALBUM : { statusCode: status }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );
}

async function renderPage() {
  render(await AlbumPage({ params: Promise.resolve({ id: ALBUM_ID }) }));
}

/** The Authorization header the album read went out with, if any. */
function albumAuth(mock: ReturnType<typeof mockFetch>): string | undefined {
  const init = (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return (init.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  token = "test-token";
  notFound.mockClear();
  redirect.mockClear();
  fetchOnboardingStatus.mockClear().mockResolvedValue({ complete: true });
  resolveOnboardingRedirect.mockClear().mockReturnValue(null);
  fetchViewerOwnLists.mockClear().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AlbumPage", () => {
  describe("for a signed-in viewer", () => {
    it("runs the onboarding gate and bounces a half-onboarded viewer", async () => {
      mockFetch();
      resolveOnboardingRedirect.mockReturnValue("/onboarding");

      await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
      expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
    });

    it("renders the album inside the app shell with the action island", async () => {
      const fetchMock = mockFetch();

      await renderPage();

      expect(
        screen.getByRole("heading", { name: "OK Computer" }),
      ).not.toBeNull();
      expect(screen.getByTestId("app-shell")).not.toBeNull();
      expect(screen.getByTestId("album-actions")).not.toBeNull();
      expect(screen.queryByTestId("clerk-sign-in-button")).toBeNull();
      expect(albumAuth(fetchMock)).toBe("Bearer test-token");
      expect(fetchViewerOwnLists).toHaveBeenCalledWith("test-token");
    });
  });

  describe("for an anonymous visitor", () => {
    beforeEach(() => {
      token = null;
    });

    it("renders the album without the onboarding gate", async () => {
      mockFetch();

      await renderPage();

      expect(
        screen.getByRole("heading", { name: "OK Computer" }),
      ).not.toBeNull();
      expect(fetchOnboardingStatus).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    });

    it("reads the album with no Authorization header and never loads own lists", async () => {
      const fetchMock = mockFetch();

      await renderPage();

      expect(albumAuth(fetchMock)).toBeUndefined();
      expect(fetchViewerOwnLists).not.toHaveBeenCalled();
    });

    it("offers a sign-in prompt that returns to this album instead of the action island", async () => {
      mockFetch();

      await renderPage();

      expect(screen.queryByTestId("album-actions")).toBeNull();
      expect(
        screen
          .getByTestId("clerk-sign-in-button")
          .getAttribute("data-force-redirect-url"),
      ).toBe(`/albums/${ALBUM_ID}`);
    });

    it("skips the signed-in app shell", async () => {
      mockFetch();

      await renderPage();

      expect(screen.queryByTestId("app-shell")).toBeNull();
    });

    it("renders the 404 page for an unknown album", async () => {
      mockFetch(404);

      await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    });
  });
});

describe("generateMetadata (album)", () => {
  const metadataFor = () =>
    generateMetadata({ params: Promise.resolve({ id: ALBUM_ID }) });

  it("titles the page with the album and artist, and sets a canonical URL", async () => {
    mockFetch();

    const metadata = await metadataFor();

    expect(metadata.title).toBe("OK Computer by Radiohead");
    expect(metadata.description).toBe(
      "OK Computer by Radiohead (1997). Rated 9.0/10 across 1 rating on Coda.",
    );
    expect(metadata.alternates?.canonical).toBe(`/albums/${ALBUM_ID}`);
  });

  it("describes an unrated album without inventing a score", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ...ALBUM,
          releaseYear: null,
          aggregateRating: { average: null, count: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const metadata = await metadataFor();

    expect(metadata.description).toBe(
      "OK Computer by Radiohead. Track, rate, and review it on Coda.",
    );
  });

  it("reads the album anonymously, even for a signed-in viewer", async () => {
    const fetchMock = mockFetch();

    await metadataFor();

    // Metadata describes the PUBLIC page, so it never carries viewer state.
    expect(albumAuth(fetchMock)).toBeUndefined();
  });

  it("falls back to no page-specific metadata for an unknown album", async () => {
    mockFetch(404);

    expect(await metadataFor()).toEqual({});
  });
});
