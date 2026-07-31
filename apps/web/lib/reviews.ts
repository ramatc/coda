import { getApiBaseUrl } from "./api-client";

/** The profile shown next to a review or one of its comments. */
export interface ReviewAuthor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** The album a review is about (always present — a required FK API-side). */
export interface ReviewAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** One comment on a review, with the caller's ownership already resolved. */
export interface ReviewComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: ReviewAuthor;
  /** `true` only when the authenticated, synced viewer wrote this comment. */
  isOwn: boolean;
}

/**
 * The viewer's own relationship to the review. Both fields are `false` for an
 * anonymous viewer, a viewer whose token failed verification, and a signed-in
 * viewer whose Clerk account has not been synced to a local `User` row yet —
 * `GET /reviews/:id` degrades all three identically rather than answering 401.
 */
export interface ReviewViewer {
  hasLiked: boolean;
  /** `true` when the viewer resolved to a local account and may write. */
  canInteract: boolean;
}

/**
 * What the like and unlike routes answer with: a counter projection, not a
 * created-resource representation (which is why both are `200`, never `201`).
 * Mirrors the API's own `ReviewLikeResult`.
 */
export interface ReviewLikeResult {
  likeCount: number;
  hasLiked: boolean;
}

/** The `GET /reviews/:id` payload (mirrors the API's own `ReviewDetail`). */
export interface ReviewDetail {
  id: string;
  body: string;
  isSpoiler: boolean;
  createdAt: string;
  updatedAt: string;
  album: ReviewAlbum;
  author: ReviewAuthor;
  likeCount: number;
  commentCount: number;
  comments: ReviewComment[];
  viewer: ReviewViewer;
}

/**
 * Sentinel distinguishing a 404 from a transport error, mirroring
 * `ALBUM_NOT_FOUND` in `lib/albums.ts` and `LIST_NOT_FOUND` in `lib/lists.ts`.
 *
 * It is deliberately ONE constant covering every not-found shape this capability
 * produces: the page-level "no such review" ({@link fetchReview} → `notFound()`),
 * the page-level "that id cannot name a review" (a 400 from the API's UUID guard
 * — see {@link NOT_FOUND_STATUSES}), and the action-level "the review vanished
 * under you" (a like/comment island rolling back). They are told apart by CALL
 * SITE, not by a second error code.
 */
export const REVIEW_NOT_FOUND = Symbol("review-not-found");

/**
 * The API's own comment bound (`apps/api/src/reviews/reviews.constants.ts`),
 * mirrored here so the comment form can count down to it client-side instead of
 * discovering the limit through a 400.
 */
export const MAX_COMMENT_LENGTH = 500;

/**
 * Empty-state copy for a review nobody has commented on yet. Kept HERE rather
 * than in the view for the same reason as `EMPTY_LIST_MESSAGE` in `lib/lists.ts`:
 * the copy belongs to the capability, so the server-rendered comment list and
 * the comment-form island never drift apart on wording.
 */
export const EMPTY_COMMENTS_MESSAGE = "No comments yet.";

/**
 * Zero-width / format code points that `String.prototype.trim()` does NOT
 * remove: U+200B ZERO WIDTH SPACE, U+200C ZERO WIDTH NON-JOINER, U+200D ZERO
 * WIDTH JOINER and U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM).
 *
 * Mirrors `ZERO_WIDTH_PATTERN` in `apps/api/src/reviews/reviews.constants.ts`,
 * and for the same narrow purpose: deciding whether a body is EMPTY. It is
 * deliberately not a sanitizer — a body mixing these with real text is real
 * content and is submitted verbatim.
 */
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;

/**
 * Whether a comment draft is empty in the same sense the API means it.
 *
 * A bare `.trim().length === 0` is NOT enough: `trim()` strips whitespace but
 * not zero-width characters, so a draft of only U+200B/200C/200D/FEFF would read
 * as non-empty here and post a comment that renders visually blank — which the
 * API then rejects with `"body is required."`. Matching the server's check keeps
 * that round trip (and that error) away from the user. Reachable by ordinary
 * clipboard paste, not just by abuse.
 */
export function isBlankCommentBody(value: string): boolean {
  return value.replace(ZERO_WIDTH_PATTERN, "").trim().length === 0;
}

/**
 * Characters still available in a comment draft, negative once it is over the
 * bound. Measures the TRIMMED length because that is exactly what the API
 * bounds — counting the raw string would block a draft the server would accept.
 */
export function remainingCommentChars(value: string): number {
  return MAX_COMMENT_LENGTH - value.trim().length;
}

/**
 * The in-app route for a review. Kept beside the fetch layer (as `HOME_PATH` is
 * kept in `lib/onboarding.ts`) because it is consumed on BOTH sides of the
 * server/client boundary: the sign-in prompt uses it as the post-sign-in
 * redirect target, so an unescaped id there would shape a redirect, not merely
 * a link.
 */
export function reviewPath(reviewId: string): string {
  return `/reviews/${encodeURIComponent(reviewId)}`;
}

/**
 * Headers for a review read. Unlike every other fetch module here, the
 * Authorization header is OMITTED entirely when there is no token instead of
 * sending `lib/lists.ts`'s `Bearer ${token ?? ""}`.
 *
 * This is load-bearing for correctness, not hygiene. `GET /reviews/:id` is the
 * app's only optional-auth route: it carries `@Public()` so the fail-closed
 * global guard lets an anonymous visitor through, plus `OptionalClerkGuard` so a
 * signed-in visitor is still resolved from their bearer token. A blank bearer
 * happens to be swallowed as anonymous today, but omitting is explicit and stays
 * correct if that exemption is ever removed. The positive direction matters just
 * as much: drop a REAL token here and a signed-in viewer is served the anonymous
 * viewer block, so every like/comment call-to-action goes dead for them.
 */
function reviewHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * `N likes`, singularized for a single like. Lives here rather than in the view
 * because the server-rendered count and the like island's optimistic count label
 * the same number on opposite sides of the server/client boundary — the same
 * reason `albumCountLabel` lives in `lib/lists.ts`.
 */
export function likeCountLabel(count: number): string {
  return count === 1 ? "1 like" : `${count} likes`;
}

/** `N comments`, singularized for a single comment. See {@link likeCountLabel}. */
export function commentCountLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

/**
 * Response statuses {@link fetchReview} reports as {@link REVIEW_NOT_FOUND}
 * instead of throwing.
 *
 * `404` is the obvious one. `400` is here because `GET /reviews/:id` accepts no
 * body and no query params, so its ONLY 400 is the service's UUID-shape guard on
 * the path segment (`validateReviewId` → "review id must be a valid id."). That
 * means "this id cannot name a review" — to a visitor, the very same story as
 * "no such review".
 *
 * Folding it in matters MORE on this route than anywhere else in the app.
 * `/reviews/[id]` is deliberately absent from `protectedRoutePatterns`, so a
 * truncated, shared, or hand-typed link reaches it without ever meeting the
 * Clerk middleware — and an unmapped 400 would drop an anonymous visitor into
 * Next's error boundary instead of the 404 page. `fetchList`/`fetchAlbumDetail`
 * do not do this, but both of those routes sit behind the middleware where the
 * same URL is far less reachable.
 *
 * Nothing else belongs in this set. A 5xx is a real fault and must stay a throw,
 * so a broken API can never masquerade as a missing review.
 */
const NOT_FOUND_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/**
 * Auth headers for a review WRITE. Deliberately NOT {@link reviewHeaders}: that
 * one omits the header for a null token because `GET /reviews/:id` is the app's
 * one optional-auth route. Every write here sits behind the plain fail-closed
 * global `ClerkGuard`, so a missing token is a legitimate **401** the island
 * should surface as "you are signed out" — sending the blank bearer that the
 * rest of `apps/web` sends keeps that answer coming from the API rather than
 * being pre-empted client-side.
 */
function authHeaders(token: string | null): Record<string, string> {
  return { Authorization: `Bearer ${token ?? ""}` };
}

/** Auth + JSON headers for the two write paths that carry a body. */
function jsonHeaders(token: string | null): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

/**
 * A failed review write, carrying the HTTP status alongside the API's own
 * message.
 *
 * The status is preserved because the islands genuinely branch on it, and the
 * three interesting cases are NOT interchangeable:
 *
 * - **409** — the like already exists server-side, so the optimistic increment
 *   is wrong and a `router.refresh()` reconciles it.
 * - **404** — the review (or comment) vanished under the viewer; roll back and
 *   let the refreshed server page surface the not-found state.
 * - **400 / 403** — a real validation or authorization answer that must be
 *   shown to the user verbatim, never retried and never disguised.
 *
 * This is exactly why {@link NOT_FOUND_STATUSES} must not be reused on write
 * paths: folding a write's 400 into "not found" would swallow "body is
 * required." and the 500-character bound, the two messages the comment form
 * exists to relay.
 */
export class ReviewActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewActionError";
  }
}

/**
 * Reads the API's own error `message` so the UI shows the backend's wording
 * ("You already liked this review.", "You can only edit your own comment.")
 * instead of guessing from the status code. Falls back to `generic` when the
 * body is not JSON or carries no string `message` — Nest emits `message` as a
 * string ARRAY for some validation errors, which is deliberately not surfaced
 * raw. Mirrors `lib/lists.ts`'s helper of the same name.
 */
async function readErrorMessage(
  response: Response,
  generic: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : generic;
  } catch {
    return generic;
  }
}

/** Throws a {@link ReviewActionError} carrying the API's message and status. */
async function throwActionError(
  response: Response,
  generic: string,
): Promise<never> {
  throw new ReviewActionError(
    await readErrorMessage(response, generic),
    response.status,
  );
}

/**
 * Fetches a review with its author, album, counts and ordered comments. Readable
 * ANONYMOUSLY — pass `null` for a logged-out visitor and the request simply goes
 * out unauthenticated (see {@link reviewHeaders}); the API answers 200 with a
 * `viewer` block of `{ hasLiked: false, canInteract: false }` rather than 401.
 *
 * Returns {@link REVIEW_NOT_FOUND} for any status in {@link NOT_FOUND_STATUSES}
 * so the page can render `notFound()`, and throws for every other non-OK
 * response.
 */
export async function fetchReview(
  token: string | null,
  id: string,
): Promise<ReviewDetail | typeof REVIEW_NOT_FOUND> {
  const response = await fetch(
    `${getApiBaseUrl()}/reviews/${encodeURIComponent(id)}`,
    { headers: reviewHeaders(token), cache: "no-store" },
  );
  if (NOT_FOUND_STATUSES.has(response.status)) {
    return REVIEW_NOT_FOUND;
  }
  if (!response.ok) {
    throw new Error(`Failed to load review (${response.status})`);
  }
  return (await response.json()) as ReviewDetail;
}

/** The `/reviews/:id/like` URL for a review. */
function likeUrl(reviewId: string): string {
  return `${getApiBaseUrl()}/reviews/${encodeURIComponent(reviewId)}/like`;
}

/** The `/reviews/:id/comments` collection URL for a review. */
function commentsUrl(reviewId: string): string {
  return `${getApiBaseUrl()}/reviews/${encodeURIComponent(reviewId)}/comments`;
}

/**
 * One comment addressed UNDER its parent review. The scoping is not cosmetic:
 * the API loads the comment by `{ id, reviewId }` precisely so a caller cannot
 * edit a comment belonging to a DIFFERENT review by supplying its id.
 */
function commentUrl(reviewId: string, commentId: string): string {
  return `${commentsUrl(reviewId)}/${encodeURIComponent(commentId)}`;
}

/**
 * Likes a review on behalf of the viewer. A duplicate is a **409** (the like
 * already exists — the composite primary key guarantees no second row), and a
 * review deleted between render and click is a **404**; both arrive as a
 * {@link ReviewActionError} so the island can roll back its optimistic
 * increment and reconcile with the server.
 */
export async function likeReview(
  token: string | null,
  reviewId: string,
): Promise<ReviewLikeResult> {
  const response = await fetch(likeUrl(reviewId), {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    await throwActionError(response, "Could not like this review.");
  }
  return (await response.json()) as ReviewLikeResult;
}

/**
 * Removes the viewer's like. Tolerant server-side — unliking something never
 * liked is a `200` no-op, deliberately NOT a 409/404 — so in practice only a
 * transport or auth failure throws here.
 */
export async function unlikeReview(
  token: string | null,
  reviewId: string,
): Promise<ReviewLikeResult> {
  const response = await fetch(likeUrl(reviewId), {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    await throwActionError(response, "Could not unlike this review.");
  }
  return (await response.json()) as ReviewLikeResult;
}

/**
 * Adds a plain-text comment (≤ {@link MAX_COMMENT_LENGTH} characters) to a
 * review. The API validates the body itself and answers **400** with the exact
 * wording the form should show ("body is required." / "body must be at most 500
 * characters."), so those messages are relayed verbatim rather than reworded.
 */
export async function createComment(
  token: string | null,
  reviewId: string,
  body: string,
): Promise<ReviewComment> {
  const response = await fetch(commentsUrl(reviewId), {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    await throwActionError(response, "Could not post this comment.");
  }
  return (await response.json()) as ReviewComment;
}

/**
 * Edits the viewer's own comment. Someone else's comment is a **403** and an
 * unknown one (or one under a different review) is a **404** — two different
 * answers the UI must keep apart, which is why {@link ReviewActionError} carries
 * the status.
 *
 * The API returns the updated comment assembled from this request's own input,
 * with no read-back after the write, so the response is always THIS caller's
 * edit even under a concurrent one. Callers should therefore trust it and
 * `router.refresh()`, never re-fetch to "confirm".
 */
export async function updateComment(
  token: string | null,
  reviewId: string,
  commentId: string,
  body: string,
): Promise<ReviewComment> {
  const response = await fetch(commentUrl(reviewId, commentId), {
    method: "PATCH",
    headers: jsonHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    await throwActionError(response, "Could not save this comment.");
  }
  return (await response.json()) as ReviewComment;
}

/**
 * Deletes the viewer's own comment. The API answers **204 with no body**, so
 * nothing is parsed on the happy path — calling `.json()` on it would throw.
 */
export async function deleteComment(
  token: string | null,
  reviewId: string,
  commentId: string,
): Promise<void> {
  const response = await fetch(commentUrl(reviewId, commentId), {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) {
    await throwActionError(response, "Could not delete this comment.");
  }
}
