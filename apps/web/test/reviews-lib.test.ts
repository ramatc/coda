import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_COMMENT_LENGTH,
  REVIEW_NOT_FOUND,
  ReviewActionError,
  commentCountLabel,
  createComment,
  deleteComment,
  fetchReview,
  isBlankCommentBody,
  likeCountLabel,
  likeReview,
  remainingCommentChars,
  reviewPath,
  unlikeReview,
  updateComment,
  type ReviewComment,
  type ReviewDetail,
  type ReviewLikeResult,
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

/** The HTTP method of the single recorded `fetch` call. */
function methodOf(mock: ReturnType<typeof vi.spyOn>): string | undefined {
  return initOf(mock).method;
}

/** The parsed JSON body of the single recorded `fetch` call. */
function bodyOf(mock: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(initOf(mock).body));
}

/** The `{ likeCount, hasLiked }` projection the like routes answer with. */
const LIKE_RESULT: ReviewLikeResult = { likeCount: 4, hasLiked: true };

/** One comment as `ReviewsService` emits it from create/edit. */
const COMMENT: ReviewComment = {
  id: COMMENT_ID,
  body: "Agreed on the fourth listen.",
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  author: { username: "jonny", displayName: "Jonny", avatarUrl: null },
  isOwn: true,
};

/** A JSON `Response` carrying an arbitrary successful payload. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mocks `fetch` with a single response and hands back the spy. */
function mockFetch(response: Response): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
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

describe("isBlankCommentBody", () => {
  it("treats an empty or whitespace-only body as blank", () => {
    expect(isBlankCommentBody("")).toBe(true);
    expect(isBlankCommentBody("   \n\t ")).toBe(true);
  });

  it("treats a body of only zero-width characters as blank", () => {
    // `String.prototype.trim()` strips whitespace but NOT U+200B/200C/200D/FEFF,
    // so a bare `.trim()` check would call this non-empty and let the form post
    // a comment that renders visually blank. The API rejects it with a 400;
    // matching that check here keeps the failure out of the user's face.
    // Written as escapes, never raw literals — the same convention the API's
    // own spec follows, so the characters stay visible to a reviewer.
    expect(isBlankCommentBody("\u200B\u200C\u200D\uFEFF")).toBe(true);
  });

  it("treats zero-width characters MIXED with real text as content", () => {
    // The guard is an emptiness TEST, not a sanitizer — over-stripping here
    // would silently block a legitimate paste.
    expect(isBlankCommentBody(" \u200Bhi ")).toBe(false);
    expect(isBlankCommentBody("hi")).toBe(false);
  });
});

describe("remainingCommentChars", () => {
  it("counts down from the API's own bound", () => {
    expect(remainingCommentChars("")).toBe(MAX_COMMENT_LENGTH);
    expect(remainingCommentChars("hi")).toBe(MAX_COMMENT_LENGTH - 2);
  });

  it("measures the TRIMMED length, exactly as the API does", () => {
    // The API bounds `value.trim().length`, so counting the raw string would
    // block a body the server would happily accept.
    expect(remainingCommentChars("  hi  ")).toBe(MAX_COMMENT_LENGTH - 2);
  });

  it("reaches zero at the boundary and goes negative past it", () => {
    expect(remainingCommentChars("x".repeat(MAX_COMMENT_LENGTH))).toBe(0);
    expect(remainingCommentChars("x".repeat(MAX_COMMENT_LENGTH + 1))).toBe(-1);
  });
});

describe("reviewPath", () => {
  it("builds the in-app route for a review", () => {
    expect(reviewPath(REVIEW_ID)).toBe(`/reviews/${REVIEW_ID}`);
  });

  it("escapes an id that would otherwise break out of the path segment", () => {
    // This value is handed to Clerk as a post-sign-in redirect target, so an
    // unescaped id is a redirect-shaping bug, not just a cosmetic one.
    expect(reviewPath("not a/uuid")).toBe("/reviews/not%20a%2Fuuid");
  });
});

describe("likeReview", () => {
  it("POSTs to the review's like route and returns the counter projection", async () => {
    const fetchMock = mockFetch(jsonResponse(LIKE_RESULT));

    expect(await likeReview("test-token", REVIEW_ID)).toEqual(LIKE_RESULT);
    expect(urlOf(fetchMock)).toContain(`/reviews/${REVIEW_ID}/like`);
    expect(methodOf(fetchMock)).toBe("POST");
    expect(headersOf(fetchMock).Authorization).toBe("Bearer test-token");
  });

  it("still sends an Authorization header when the token is null", async () => {
    const fetchMock = mockFetch(jsonResponse(LIKE_RESULT));

    await likeReview(null, REVIEW_ID);

    // Deliberately NOT `reviewHeaders`' omit-when-null posture. The write routes
    // sit behind the fail-closed global `ClerkGuard`, so a missing token is a
    // legitimate 401 the island must surface — omitting the header would make
    // that failure look like a transport bug instead of "you are signed out".
    expect(headersOf(fetchMock).Authorization).toBe("Bearer ");
  });

  it("throws a 409 carrying the API's duplicate-like message", async () => {
    mockFetch(errorResponse(409, "You already liked this review."));

    const error = await likeReview("test-token", REVIEW_ID).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ReviewActionError);
    expect((error as ReviewActionError).status).toBe(409);
    expect((error as ReviewActionError).message).toBe(
      "You already liked this review.",
    );
  });

  it("throws a 404 when the review vanished between render and click", async () => {
    mockFetch(errorResponse(404, "Review not found."));

    const error = await likeReview("test-token", REVIEW_ID).catch(
      (err: unknown) => err,
    );

    // The island keys its "reconcile with the server" branch off this status,
    // so it has to survive as a number rather than collapsing into a message.
    expect((error as ReviewActionError).status).toBe(404);
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    mockFetch(new Response("<html>502</html>", { status: 502 }));

    const error = await likeReview("test-token", REVIEW_ID).catch(
      (err: unknown) => err,
    );

    expect((error as ReviewActionError).status).toBe(502);
    expect((error as ReviewActionError).message).toBe(
      "Could not like this review.",
    );
  });

  it("escapes the review id it interpolates into the URL", async () => {
    const fetchMock = mockFetch(jsonResponse(LIKE_RESULT));

    await likeReview("test-token", "not a/uuid");

    expect(urlOf(fetchMock)).toContain("/reviews/not%20a%2Fuuid/like");
  });
});

describe("unlikeReview", () => {
  it("DELETEs the like and returns the refreshed counter projection", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ likeCount: 3, hasLiked: false }),
    );

    expect(await unlikeReview("test-token", REVIEW_ID)).toEqual({
      likeCount: 3,
      hasLiked: false,
    });
    expect(urlOf(fetchMock)).toContain(`/reviews/${REVIEW_ID}/like`);
    expect(methodOf(fetchMock)).toBe("DELETE");
  });

  it("throws with the API's message on a non-OK response", async () => {
    mockFetch(errorResponse(500, "Internal server error"));

    const error = await unlikeReview("test-token", REVIEW_ID).catch(
      (err: unknown) => err,
    );

    expect((error as ReviewActionError).status).toBe(500);
  });
});

describe("createComment", () => {
  it("POSTs the body as JSON and returns the created comment", async () => {
    const fetchMock = mockFetch(jsonResponse(COMMENT, 201));

    expect(
      await createComment(
        "test-token",
        REVIEW_ID,
        "Agreed on the fourth listen.",
      ),
    ).toEqual(COMMENT);
    expect(urlOf(fetchMock)).toContain(`/reviews/${REVIEW_ID}/comments`);
    expect(methodOf(fetchMock)).toBe("POST");
    expect(headersOf(fetchMock)["Content-Type"]).toBe("application/json");
    expect(bodyOf(fetchMock)).toEqual({ body: "Agreed on the fourth listen." });
  });

  it("surfaces a validation 400 instead of swallowing it as not-found", async () => {
    mockFetch(errorResponse(400, "body is required."));

    const error = await createComment("test-token", REVIEW_ID, "   ").catch(
      (err: unknown) => err,
    );

    // The whole reason `NOT_FOUND_STATUSES` must NOT be reused on write paths:
    // `GET /reviews/:id` has exactly one 400 (the id guard), but the write
    // routes have REAL validation 400s the form has to show the user.
    expect((error as ReviewActionError).status).toBe(400);
    expect((error as ReviewActionError).message).toBe("body is required.");
  });

  it("surfaces the API's own over-length message verbatim", async () => {
    mockFetch(errorResponse(400, "body must be at most 500 characters."));

    const error = await createComment("test-token", REVIEW_ID, "x").catch(
      (err: unknown) => err,
    );

    expect((error as ReviewActionError).message).toBe(
      "body must be at most 500 characters.",
    );
  });

  it("throws a 404 when the review is gone", async () => {
    mockFetch(errorResponse(404, "Review not found."));

    const error = await createComment("test-token", REVIEW_ID, "Hi.").catch(
      (err: unknown) => err,
    );

    expect((error as ReviewActionError).status).toBe(404);
  });
});

describe("updateComment", () => {
  it("PATCHes the comment under its parent review and returns it", async () => {
    const fetchMock = mockFetch(jsonResponse({ ...COMMENT, body: "Edited." }));

    const result = await updateComment(
      "test-token",
      REVIEW_ID,
      COMMENT_ID,
      "Edited.",
    );

    expect(result.body).toBe("Edited.");
    // Scoped under the review: the API refuses to edit a comment addressed
    // outside its own parent, and this URL shape is what enforces that.
    expect(urlOf(fetchMock)).toContain(
      `/reviews/${REVIEW_ID}/comments/${COMMENT_ID}`,
    );
    expect(methodOf(fetchMock)).toBe("PATCH");
    expect(bodyOf(fetchMock)).toEqual({ body: "Edited." });
  });

  it("throws a 403 with the API's author-only message", async () => {
    mockFetch(errorResponse(403, "You can only edit your own comment."));

    const error = await updateComment(
      "test-token",
      REVIEW_ID,
      COMMENT_ID,
      "Edited.",
    ).catch((err: unknown) => err);

    // 403 and 404 mean genuinely different things here (someone else's comment
    // vs. no such comment under this review) and must not be collapsed.
    expect((error as ReviewActionError).status).toBe(403);
    expect((error as ReviewActionError).message).toBe(
      "You can only edit your own comment.",
    );
  });

  it("throws a 404 for a comment that is not under this review", async () => {
    mockFetch(errorResponse(404, "Comment not found."));

    const error = await updateComment(
      "test-token",
      REVIEW_ID,
      COMMENT_ID,
      "Edited.",
    ).catch((err: unknown) => err);

    expect((error as ReviewActionError).status).toBe(404);
  });
});

describe("deleteComment", () => {
  it("DELETEs the scoped comment and resolves without parsing a body", async () => {
    // The API answers 204 with NO body — calling `.json()` on this response
    // would throw, so resolving proves the happy path never parses one.
    const fetchMock = mockFetch(new Response(null, { status: 204 }));

    await expect(
      deleteComment("test-token", REVIEW_ID, COMMENT_ID),
    ).resolves.toBeUndefined();
    expect(urlOf(fetchMock)).toContain(
      `/reviews/${REVIEW_ID}/comments/${COMMENT_ID}`,
    );
    expect(methodOf(fetchMock)).toBe("DELETE");
  });

  it("throws a 403 when the comment belongs to someone else", async () => {
    mockFetch(errorResponse(403, "You can only edit your own comment."));

    const error = await deleteComment(
      "test-token",
      REVIEW_ID,
      COMMENT_ID,
    ).catch((err: unknown) => err);

    expect((error as ReviewActionError).status).toBe(403);
  });
});
