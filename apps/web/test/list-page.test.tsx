// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

/** The Clerk token `auth()` hands the page for the current test. */
let token: string | null = "test-token";

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
// Throws like the real `redirect()` does, so a test that expects the onboarding
// gate to bounce proves the page STOPPED there rather than merely called it. The
// destination is carried in the message as well as recorded on the mock, so a
// wrong-target redirect is legible from the failure alone.
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const fetchOnboardingStatus = vi.fn();
const resolveOnboardingRedirect = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(token) }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (url: string) => redirect(url),
  // The islands composed into the page are client components that call
  // `useRouter().refresh()` after a successful write.
  useRouter: () => ({ refresh: refreshMock }),
}));

// The islands' own Clerk surface. Kept as a framework boundary only: the real
// island components run, so this file tests COMPOSITION (which island is
// mounted, with which props) rather than re-testing island internals. No
// `SignInButton` double is needed here, unlike `review-page.test.tsx`:
// `/lists(.*)` is a protected route, so no island on this page has an anonymous
// branch — and its absence is what would fail loudly if one appeared.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

// Every prop other than `href` is forwarded rather than dropped, so
// `data-testid` and friends survive into the DOM — without that, a
// `getByTestId` on a link silently fails and a `not.toContain(testid)`
// assertion passes for the wrong reason.
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

// Mocked so the assertions below can PROVE the gate ran, rather than merely
// observing that nothing redirected. Unlike `/reviews/[id]`, this page MUST run
// it: `/lists(.*)` is protected, so a half-onboarded viewer belongs at
// `/onboarding`, not here.
vi.mock("../lib/onboarding", () => ({
  fetchOnboardingStatus: () => fetchOnboardingStatus(),
  resolveOnboardingRedirect: (...args: unknown[]) =>
    resolveOnboardingRedirect(...args),
}));

const { default: ListPage } = await import("../app/lists/[id]/page");

const LIST_ID = "22222222-2222-4222-8222-222222222222";
/** The list owner's LOCAL user id — what `GET /profile` returns for the owner. */
const OWNER_ID = "user-owner";
/** Some other viewer's local id, so `isListOwner` answers a definitive false. */
const VISITOR_ID = "user-visitor";

/** The `GET /lists/:id` payload for a public, ranked list with one album. */
const LIST = {
  id: LIST_ID,
  userId: OWNER_ID,
  title: "Deep cuts",
  description: "Slow burners only.",
  isRanked: true,
  isPublic: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  items: [
    {
      id: "item-1",
      position: 1,
      note: null,
      album: {
        id: "album-1",
        title: "Kid A",
        coverUrl: null,
        primaryArtistName: "Radiohead",
      },
    },
  ],
  likeCount: 4,
  viewerHasLiked: false,
};

/** A JSON `Response` carrying the list payload, with overrides applied. */
function listResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ...LIST, ...overrides }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` for `GET /profile`, resolving the viewer's local id. */
function profileResponse(userId: string): Response {
  return new Response(JSON.stringify({ userId, username: "someone" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` with only a status — for the not-found and failure paths. */
function statusResponse(status: number): Response {
  return new Response(JSON.stringify({ statusCode: status }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes the page's TWO parallel reads by URL. `fetchList` and
 * `fetchViewerUserId` are issued together in one `Promise.all`, so a single
 * blanket `mockResolvedValue` would serve the list payload to `GET /profile`
 * as well and quietly make every viewer look like the owner.
 *
 * Each factory is called PER REQUEST because a `Response` body can only be read
 * once, and the profile read retries on a 5xx.
 */
function mockFetch(
  routes: { list?: () => Response; profile?: () => Response } = {},
) {
  const list = routes.list ?? (() => listResponse());
  const profile = routes.profile ?? (() => profileResponse(OWNER_ID));

  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/profile")) {
        return Promise.resolve(profile());
      }
      if (url.includes(`/lists/${LIST_ID}`)) {
        return Promise.resolve(list());
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
}

/** Renders the async server page for `LIST_ID`. */
async function renderPage() {
  render(await ListPage({ params: Promise.resolve({ id: LIST_ID }) }));
}

/** The Authorization header of the first request whose URL contains `fragment`. */
function authFor(
  mock: ReturnType<typeof mockFetch>,
  fragment: string,
): string | undefined {
  const call = mock.mock.calls.find((args) =>
    String(args[0]).includes(fragment),
  );
  const headers = ((call?.[1] ?? {}) as RequestInit).headers as
    Record<string, string> | undefined;
  return headers?.Authorization;
}

beforeEach(() => {
  token = "test-token";
  notFound.mockClear();
  redirect.mockClear();
  refreshMock.mockClear();
  fetchOnboardingStatus.mockClear().mockResolvedValue({ complete: true });
  resolveOnboardingRedirect.mockClear().mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ListPage", () => {
  it("renders the list for its owner", async () => {
    mockFetch();

    await renderPage();

    expect(screen.getByRole("heading", { name: "Deep cuts" })).not.toBeNull();
    expect(screen.getByText("Slow burners only.")).not.toBeNull();
  });

  it("sends the viewer's token to BOTH reads, not just the list", async () => {
    const fetchMock = mockFetch();

    await renderPage();

    // Ownership can only be decided by comparing `ListDetail.userId` against the
    // viewer's LOCAL id, and `GET /profile` is the only endpoint that exposes
    // it — an unauthenticated profile read would silently demote the owner.
    expect(authFor(fetchMock, `/lists/${LIST_ID}`)).toBe("Bearer test-token");
    expect(authFor(fetchMock, "/profile")).toBe("Bearer test-token");
  });

  it("runs the onboarding gate and bounces a half-onboarded viewer", async () => {
    resolveOnboardingRedirect.mockReturnValue("/onboarding");
    mockFetch();

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT");

    // `/lists(.*)` IS protected, so — unlike `/reviews/[id]` — this page must
    // run the gate, and it must run BEFORE the reads so a bounced viewer never
    // triggers them.
    expect(fetchOnboardingStatus).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("asks the gate to return to THIS list after onboarding", async () => {
    mockFetch();

    await renderPage();

    expect(resolveOnboardingRedirect).toHaveBeenCalledWith(
      { complete: true },
      `/lists/${LIST_ID}`,
    );
  });

  it("renders the 404 page for an unknown or private-to-this-viewer list", async () => {
    mockFetch({ list: () => statusResponse(404) });

    // A 404 covers both cases on purpose, so `notFound()` never leaks a private
    // list's existence.
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("mounts the like island seeded from the list's OWN payload", async () => {
    mockFetch({ list: () => listResponse({ likeCount: 4 }) });

    await renderPage();

    // Seeded from the server's count, so the first paint already agrees with
    // the page rather than starting at zero.
    expect(screen.getByTestId("list-like-count").textContent).toBe("4 likes");
    expect(
      screen.getByRole("button", { name: "Like this list" }),
    ).not.toBeNull();
  });

  it("seeds the like island with the viewer's existing like state", async () => {
    mockFetch({ list: () => listResponse({ viewerHasLiked: true }) });

    await renderPage();

    // `viewerHasLiked` describes the caller whose token fetched the payload and
    // is never derived here. Without it plumbed through, a viewer who already
    // liked the list would be offered "Like" again and their click would 409.
    expect(
      screen.getByRole("button", { name: "Unlike this list" }),
    ).not.toBeNull();
  });

  it("gives a NON-owner the like control too, since likes follow read visibility", async () => {
    mockFetch({ profile: () => profileResponse(VISITOR_ID) });

    await renderPage();

    // The one slot on this page that is NOT owner-gated: the API gates likes on
    // READ visibility, so anyone who can see the page may like it. Gating it
    // would withhold a control the API would happily accept.
    expect(
      screen.getByRole("button", { name: "Like this list" }),
    ).not.toBeNull();
    // ...while the owner-only islands stay absent for the same viewer, which is
    // what makes the assertion above a real distinction rather than a tautology.
    expect(screen.queryByRole("button", { name: "Edit list" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete list" })).toBeNull();
  });

  it("hands the owner the edit, delete and reorder islands", async () => {
    mockFetch();

    await renderPage();

    expect(screen.getByRole("button", { name: "Edit list" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Delete list" })).not.toBeNull();
    // The reorder island replaces the read-only rendering for the owner.
    expect(
      screen.getByRole("button", {
        name: "Reorder Kid A by Radiohead, position 1",
      }),
    ).not.toBeNull();
  });

  it("gives a non-owner the read-only items instead of the reorder island", async () => {
    mockFetch({ profile: () => profileResponse(VISITOR_ID) });

    await renderPage();

    expect(screen.getByText("Kid A")).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Reorder Kid A by Radiohead, position 1",
      }),
    ).toBeNull();
  });

  it("flags ownership as UNVERIFIED when the profile read cannot resolve the viewer", async () => {
    mockFetch({ profile: () => statusResponse(404) });

    await renderPage();

    // A `null` viewer id is indistinguishable from "not the owner" to
    // `isListOwner`, so the page surfaces the difference itself: a real owner
    // hit by a transient failure sees WHY their controls are missing instead of
    // the page silently looking like a visitor view.
    expect(screen.getByRole("alert").textContent).toBe(
      "Some features may be unavailable right now — refresh to retry.",
    );
    expect(screen.queryByRole("button", { name: "Edit list" })).toBeNull();
  });

  it("does not flag ownership unverified for a definitively resolved visitor", async () => {
    mockFetch({ profile: () => profileResponse(VISITOR_ID) });

    await renderPage();

    // The notice is for the DEGRADED case only — a genuine visitor is not shown
    // an error about a page that is rendering exactly as intended for them.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
