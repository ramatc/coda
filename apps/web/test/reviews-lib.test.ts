import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_COMMENT_LENGTH,
  REVIEW_NOT_FOUND,
  commentCountLabel,
  fetchReview,
  likeCountLabel,
  type ReviewDetail,
} from "../lib/reviews";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

/**
 * The `GET /reviews/:id` payload exactly as `ReviewsService.getReview` emits it
 * (`apps/api/src/reviews/reviews.service.ts`), so a drift between the API's
 * `ReviewDetail` and this module's mirror shows up as a test failure rather than
 * as `undefined` on a page.
 */
const REVIEW: ReviewDetail = {
  id: REVIEW_ID,
  body: "A slow burn that finally clicks on the fourth listen.",
  isSpoiler: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  album: {
    id: ALBUM_ID,
    title: "Kid A",
    coverUrl: "https://cdn.example/kid-a.jpg",
    primaryArtistName: "Radiohead",
  },
  author: {
    username: "thom",
    displayName: "Thom",
    avatarUrl: null,
  },
  likeCount: 3,
  commentCount: 1,
  comments: [
    {
      id: COMMENT_ID,
      body: "Agreed on the fourth listen.",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      author: { username: "jonny", displayName: "Jonny", avatarUrl: null },
      isOwn: false,
    },
  ],
  viewer: { hasLiked: false, canInteract: false },
};

/** A JSON `Response` carrying the API's review-detail payload. */
function reviewResponse(status = 200): Response {
  return new Response(JSON.stringify(REVIEW), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` carrying a Nest-shaped error body. */
function errorResponse(status: number, message?: unknown): Response {
  return new Response(JSON.stringify({ statusCode: status, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `init` argument of the single recorded `fetch` call. */
function initOf(mock: ReturnType<typeof vi.spyOn>): RequestInit {
  return (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
}

/** The headers of the single recorded `fetch` call, as a plain record. */
function headersOf(mock: ReturnType<typeof vi.spyOn>): Record<string, string> {
  return (initOf(mock).headers ?? {}) as Record<string, string>;
}

/** The URL of the single recorded `fetch` call. */
function urlOf(mock: ReturnType<typeof vi.spyOn>): string {
  return String(mock.mock.calls[0]?.[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchReview", () => {
  it("maps the API payload onto a ReviewDetail, nested comments included", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reviewResponse());

    const result = await fetchReview("test-token", REVIEW_ID);

    expect(result).toEqual(REVIEW);
    expect(urlOf(fetchMock)).toContain(`/reviews/${REVIEW_ID}`);
  });

  it("returns the not-found sentinel for a 404 rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404));

    expect(await fetchReview("test-token", REVIEW_ID)).toBe(REVIEW_NOT_FOUND);
  });

  it("returns the not-found sentinel for a 400 raised by a malformed id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(400, "review id must be a valid id."),
    );

    // `GET /reviews/:id` takes no body and no query params, so its ONLY 400 is
    // the malformed-id guard. To a visitor that is indistinguishable from "no
    // such review", and this route is public — a truncated or hand-typed link
    // reaches it without ever meeting the Clerk middleware.
    expect(await fetchReview(null, "not-a-uuid")).toBe(REVIEW_NOT_FOUND);
  });

  it("still throws for a server-side failure so the page surfaces an error boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(500));

    // Only 400/404 are folded into the sentinel. A 5xx is a real fault and must
    // NOT be disguised as a missing review.
    await expect(fetchReview("test-token", REVIEW_ID)).rejects.toThrow(
      "Failed to load review (500)",
    );
  });

  it("sends the bearer token when the viewer has one", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reviewResponse());

    await fetchReview("test-token", REVIEW_ID);

    expect(headersOf(fetchMock).Authorization).toBe("Bearer test-token");
  });

  it("omits the Authorization header entirely for an anonymous viewer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reviewResponse());

    await fetchReview(null, REVIEW_ID);

    // A blank `Bearer ` (what `lib/lists.ts` sends) would be swallowed as
    // anonymous by OptionalClerkGuard today, but omitting is explicit and stays
    // correct if the route's `@Public()` exemption is ever removed.
    expect(headersOf(fetchMock)).not.toHaveProperty("Authorization");
  });

  it("escapes the id it interpolates into the URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(404));

    await fetchReview(null, "not a/uuid");

    expect(urlOf(fetchMock)).toContain("/reviews/not%20a%2Fuuid");
  });
});

describe("likeCountLabel", () => {
  it("singularizes a single like", () => {
    expect(likeCountLabel(1)).toBe("1 like");
  });

  it("pluralizes every other count, zero included", () => {
    expect(likeCountLabel(0)).toBe("0 likes");
    expect(likeCountLabel(3)).toBe("3 likes");
  });
});

describe("commentCountLabel", () => {
  it("singularizes a single comment", () => {
    expect(commentCountLabel(1)).toBe("1 comment");
  });

  it("pluralizes every other count, zero included", () => {
    expect(commentCountLabel(0)).toBe("0 comments");
    expect(commentCountLabel(2)).toBe("2 comments");
  });
});

describe("MAX_COMMENT_LENGTH", () => {
  it("mirrors the API's own comment bound so the form never over-submits", () => {
    // Pinned against `apps/api/src/reviews/reviews.constants.ts`. Raising one
    // side without the other either truncates a valid comment client-side or
    // lets the form submit a body the API answers with a 400.
    expect(MAX_COMMENT_LENGTH).toBe(500);
  });
});
