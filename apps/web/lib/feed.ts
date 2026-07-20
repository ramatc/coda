import { getApiBaseUrl } from "./api-client";

/** The three kinds of tracked activity (mirrors the API's `ActivityType`). */
export type FeedActivityType = "LISTEN" | "RATING" | "REVIEW";

/** The album a feed event refers to (always present). */
export interface FeedItemAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** The followed user who produced a feed event (mirrors the API's `FeedActor`). */
export interface FeedActor {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * One entry in the followed-activity feed (mirrors the API's `FeedItem`). Shares
 * the personal-stream item shape (`GET /me/activity`) — same orphan-safe
 * `score`/`reviewBody` fields — plus an `actor` identifying which followed user
 * produced the event.
 */
export interface FeedItem {
  id: string;
  type: FeedActivityType;
  occurredAt: string;
  album: FeedItemAlbum;
  /** Score (1-10) for a RATING event, else `null`. */
  score: number | null;
  /** Review body for a REVIEW event, else `null`. */
  reviewBody: string | null;
  /** The followed user who produced this event. */
  actor: FeedActor;
}

/** A cursor-paginated page of the viewer's followed-activity feed. */
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

/** Sentinel distinguishing a 400 (malformed `cursor`) from a transport error. */
export const INVALID_CURSOR = Symbol("invalid-cursor");

/**
 * Fetches a page of the viewer's followed-activity feed server-side with their
 * Clerk token. `cursor` requests the next (older) page. Returns
 * {@link INVALID_CURSOR} for a 400 (the API rejects a malformed cursor) so the
 * page can fall back to the first page instead of crashing, and throws for any
 * other non-OK response so the route's error boundary surfaces a transport
 * failure — the feed is the page's primary content, and an empty page is a
 * legitimate state the API returns explicitly (`{ items: [], nextCursor: null }`
 * for an unsynced or follows-nobody caller), not something to fabricate on error.
 *
 * Mirrors `lib/activity.ts`'s `fetchActivity`: the client never sends `limit`, so
 * every 400 is treated as a bad `cursor`. Revisit if `limit` becomes
 * client-controlled.
 */
export async function fetchFeed(
  token: string | null,
  cursor?: string,
): Promise<FeedPage | typeof INVALID_CURSOR> {
  const url = new URL(`${getApiBaseUrl()}/feed`);
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
    throw new Error(`Failed to load feed (${response.status})`);
  }
  return (await response.json()) as FeedPage;
}
