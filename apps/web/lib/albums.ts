import { getApiBaseUrl } from "./api-client";

/** A single track on the album tracklist (mirrors the API's `AlbumDetailTrack`). */
export interface AlbumDetailTrack {
  id: string;
  position: number;
  title: string;
  durationMs: number | null;
}

/** A genre tag on the album. */
export interface AlbumDetailGenre {
  id: string;
  slug: string;
  name: string;
}

/** The album's aggregate rating (mean + count) across every user. */
export interface AlbumAggregateRating {
  average: number | null;
  count: number;
}

/** The current viewer's own tracking state for the album. */
export interface AlbumViewerState {
  listened: boolean;
  listenId: string | null;
  score: number | null;
  review: string | null;
}

/** The album-detail payload from `GET /albums/:id`. */
export interface AlbumDetail {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  trackCount: number | null;
  primaryArtist: { id: string; name: string };
  genres: AlbumDetailGenre[];
  tracks: AlbumDetailTrack[];
  aggregateRating: AlbumAggregateRating;
  viewer: AlbumViewerState;
}

/** Inclusive rating bounds, matching the API's `1 <= score <= 10` contract. */
export const MIN_RATING = 1;
export const MAX_RATING = 10;

/** Sentinel distinguishing a 404 (album not found) from a transport error. */
export const ALBUM_NOT_FOUND = Symbol("album-not-found");

/**
 * Fetches an album's detail server-side with the viewer's Clerk token. Returns
 * {@link ALBUM_NOT_FOUND} for a 404 so the page can render `notFound()`, and
 * throws for any other non-OK response (the caller surfaces an error boundary).
 */
export async function fetchAlbumDetail(
  token: string | null,
  id: string,
): Promise<AlbumDetail | typeof ALBUM_NOT_FOUND> {
  const response = await fetch(
    `${getApiBaseUrl()}/albums/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    },
  );
  if (response.status === 404) {
    return ALBUM_NOT_FOUND;
  }
  if (!response.ok) {
    throw new Error(`Failed to load album (${response.status})`);
  }
  return (await response.json()) as AlbumDetail;
}

function authHeaders(token: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${token ?? ""}`,
    "Content-Type": "application/json",
  };
}

/**
 * Shown for a 404 on a write path when the API's `resolveUserId` reports its
 * stable `ACCOUNT_NOT_SYNCED` code — the caller's local `User` row hasn't been
 * created yet by the Clerk webhook (a real, expected transient state, not a
 * genuine failure) — so it gets its own message rather than collapsing into
 * the generic per-mutation fallback below.
 */
const ACCOUNT_SYNCING_MESSAGE =
  "Your account is still syncing — try again in a moment.";

/** The API's stable error code identifying the "account still syncing" 404. */
const ACCOUNT_NOT_SYNCED_CODE = "ACCOUNT_NOT_SYNCED";

/** A 404 error body's `message` and/or stable discriminator `code`. */
interface ErrorBody {
  message?: string;
  code?: string;
}

/** Reads a JSON error body's `message`/`code` fields, tolerating a non-JSON body. */
async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const body = (await response.json()) as { message?: unknown; code?: unknown };
    return {
      message: typeof body.message === "string" ? body.message : undefined,
      code: typeof body.code === "string" ? body.code : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolves the message for a 404 on a write path: the friendly "still
 * syncing" copy ONLY when the API reports its stable `ACCOUNT_NOT_SYNCED`
 * code, otherwise the backend's raw `message` (any other 404), else a generic
 * fallback. A `message` is always present on the account-not-synced 404 too,
 * so checking `code` (rather than "is a message present") is what actually
 * distinguishes the two cases (judgment-day PR9 round 3, finding #1).
 */
async function readNotFoundMessage(
  response: Response,
  genericMessage: string,
): Promise<string> {
  const body = await readErrorBody(response);
  if (body.code === ACCOUNT_NOT_SYNCED_CODE) {
    return ACCOUNT_SYNCING_MESSAGE;
  }
  return body.message ?? genericMessage;
}

/** Marks the album as listened (idempotent server-side). */
export async function markListened(
  token: string | null,
  albumId: string,
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/listens`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ albumId }),
  });
  if (!response.ok) {
    const generic = "Could not mark this album as listened.";
    if (response.status === 404) {
      throw new Error(await readNotFoundMessage(response, generic));
    }
    throw new Error(generic);
  }
}

/** Deletes one of the viewer's listens by id. */
export async function deleteListen(
  token: string | null,
  listenId: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/listens/${encodeURIComponent(listenId)}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!response.ok) {
    const generic = "Could not remove this listen.";
    if (response.status === 404) {
      throw new Error(await readNotFoundMessage(response, generic));
    }
    throw new Error(generic);
  }
}

/** Creates or edits the viewer's rating (integer 1-10). */
export async function rateAlbum(
  token: string | null,
  albumId: string,
  score: number,
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/ratings`, {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify({ albumId, score }),
  });
  if (!response.ok) {
    const generic = "Could not save your rating.";
    if (response.status === 404) {
      throw new Error(await readNotFoundMessage(response, generic));
    }
    throw new Error(generic);
  }
}

/** Deletes the viewer's rating for the album (also removes any review). */
export async function deleteRating(
  token: string | null,
  albumId: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/ratings/${encodeURIComponent(albumId)}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!response.ok) {
    const generic = "Could not remove your rating.";
    if (response.status === 404) {
      throw new Error(await readNotFoundMessage(response, generic));
    }
    throw new Error(generic);
  }
}

/**
 * Writes or edits the viewer's plain-text review. The API requires an existing
 * rating (the schema subordinates a review to a rating) and returns 400 on an
 * unrated album — the caller gates the review control on a present score.
 */
export async function writeReview(
  token: string | null,
  albumId: string,
  body: string,
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/reviews`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ albumId, body }),
  });
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error("Rate this album before writing a review.");
    }
    const generic = "Could not save your review.";
    if (response.status === 404) {
      throw new Error(await readNotFoundMessage(response, generic));
    }
    throw new Error(generic);
  }
}
