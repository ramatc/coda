import { getApiBaseUrl } from "./api-client";

/** The three kinds of tracked activity (mirrors the API's `ActivityType`). */
export type ActivityType = "LISTEN" | "RATING" | "REVIEW";

/** The album an activity item refers to (always present). */
export interface ActivityItemAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** One entry in the personal activity stream (mirrors the API's `ActivityItem`). */
export interface ActivityItem {
  id: string;
  type: ActivityType;
  occurredAt: string;
  album: ActivityItemAlbum;
  /** Score (1-10) for a RATING event, else `null`. */
  score: number | null;
  /** Review body for a REVIEW event, else `null`. */
  reviewBody: string | null;
  /**
   * The id of the review behind a REVIEW event, else `null`. Lets the card link
   * to `/reviews/:reviewId`; `null` means there is nothing to link to (a
   * non-REVIEW event, or a stranded event whose review was deleted).
   */
  reviewId: string | null;
  /**
   * How many likes the review has, or `null` when there is no review. `0` is a
   * real value and is deliberately NOT collapsed into `null`: "nobody liked it
   * yet" must stay distinguishable from "there is no review". Read the trio via
   * {@link reviewId} — never via a falsy check on a count.
   */
  reviewLikeCount: number | null;
  /** How many comments the review has, or `null`. Same contract as {@link reviewLikeCount}. */
  reviewCommentCount: number | null;
}

/** A cursor-paginated page of the viewer's own activity. */
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

/** Sentinel distinguishing a 400 (malformed `cursor`) from a transport error. */
export const INVALID_CURSOR = Symbol("invalid-cursor");

/**
 * Fetches a page of the viewer's own activity server-side with their Clerk
 * token. `cursor` requests the next (older) page. Returns {@link INVALID_CURSOR}
 * for a 400 (the API rejects a malformed cursor) so the page can fall back to
 * the first page instead of crashing, and throws for any other non-OK response
 * so the route's error boundary surfaces a transport failure (the feed is the
 * page's primary content — an empty page is a legitimate state the API returns
 * explicitly, not something to fabricate on error).
 *
 * Accepted assumption (judgment-day PR10 round 2): every 400 from this
 * endpoint is treated as a bad `cursor`, since `limit` is never sent by this
 * client. `GET /me/activity` can also 400 on a bad `limit` — if a caller
 * ever starts sending one, this would misattribute that error as "bad
 * cursor, retry page 1" instead of surfacing it. Revisit if `limit` becomes
 * client-controlled.
 */
export async function fetchActivity(
  token: string | null,
  cursor?: string,
): Promise<ActivityPage | typeof INVALID_CURSOR> {
  const url = new URL(`${getApiBaseUrl()}/me/activity`);
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token ?? ""}` },
    cache: "no-store",
  });
  if (response.status === 400) {
    return INVALID_CURSOR;
  }
  if (!response.ok) {
    throw new Error(`Failed to load activity (${response.status})`);
  }
  return (await response.json()) as ActivityPage;
}
