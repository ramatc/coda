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
