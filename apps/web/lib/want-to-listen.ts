import { getApiBaseUrl } from "./api-client";

/** The album denormalized onto a want-to-listen entry, as returned by the API. */
export interface WantToListenAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/**
 * One entry in a user's want-to-listen backlog (mirrors the API's
 * `WantToListenEntry`). `albumId` is carried alongside the nested album because
 * the unmark endpoint is addressed BY ALBUM (`DELETE /want-to-listen/:albumId`),
 * not by the entry's own `id`.
 */
export interface WantToListenEntry {
  id: string;
  albumId: string;
  createdAt: string;
  album: WantToListenAlbum;
}

/** The raw row returned by `POST /want-to-listen` (no album denormalized). */
export interface WantToListenRow {
  id: string;
  albumId: string;
  createdAt: string;
}

/**
 * Empty-state copy for a backlog with no (unresolved) entries. Kept HERE rather
 * than in the profile section for the same reason as `EMPTY_LIST_MESSAGE` in
 * `lib/lists.ts`: the copy belongs to the capability, not to one component, so
 * anything else rendering this backlog reuses the identical wording.
 */
export const EMPTY_WANT_TO_LISTEN_MESSAGE =
  "Nothing on the want-to-listen list yet.";

/**
 * Zero-state used when the backlog endpoint fails. The profile still renders its
 * (empty) section rather than throwing during render — the section MUST always
 * exist per the spec, so degrading to empty is the only safe direction. Same
 * fail-safe posture as `fetchSocialStats`.
 */
const EMPTY_ENTRIES: WantToListenEntry[] = [];

/** Auth-only headers for reads and body-less writes. */
function authHeaders(token: string | null): Record<string, string> {
  return { Authorization: `Bearer ${token ?? ""}` };
}

/** Auth + JSON headers for the one write path that carries a body. */
function jsonHeaders(token: string | null): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

/**
 * Reads the API's own error `message` so the UI surfaces the backend's wording
 * ("This album is already on your want-to-listen list.", "Want-to-listen entry
 * not found.") instead of guessing from the status code. Falls back to `generic`
 * when the body is not JSON or carries no string `message` — Nest also emits
 * `message` as a string ARRAY for some validation errors, which is deliberately
 * NOT surfaced raw. Mirrors the identical helper in `lib/lists.ts`; each fetch
 * module stays self-contained, as `authHeaders` already is across this folder.
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

/** Throws an `Error` carrying the API's message (or `generic`) for a non-OK response. */
async function throwApiError(
  response: Response,
  generic: string,
): Promise<never> {
  throw new Error(await readErrorMessage(response, generic));
}

/**
 * Fetches `username`'s want-to-listen backlog for their profile section,
 * server-side, with the viewer's Clerk token. The endpoint is PUBLIC — the
 * caller's identity does not filter the result — and already applies read-time
 * auto-resolve, so an album the profile owner has listened to or rated is
 * absent from the payload; the UI never re-filters.
 *
 * A network failure or non-OK response fails safe to an EMPTY section instead of
 * throwing during render, so a profile still renders when the backlog endpoint
 * is unavailable. An empty array is therefore ambiguous between "nothing marked"
 * and "could not load" — accepted deliberately, because the spec requires the
 * section to exist either way and its empty state reads correctly in both.
 *
 * A successful response whose body is not an array (backend hiccup,
 * misconfigured proxy) degrades the same way — matching `fetchUserLists`'s
 * `Array.isArray` guard in `lib/lists.ts` — so the section never throws during
 * render just because a 200 carried an unexpected shape.
 */
export async function fetchWantToListen(
  token: string | null,
  username: string,
): Promise<WantToListenEntry[]> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/users/${encodeURIComponent(username)}/want-to-listen`,
      { headers: authHeaders(token), cache: "no-store" },
    );
    if (!response.ok) {
      return EMPTY_ENTRIES;
    }
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as WantToListenEntry[]) : EMPTY_ENTRIES;
  } catch {
    return EMPTY_ENTRIES;
  }
}

/**
 * Marks an album as want-to-listen for the caller. Throws with the API's own
 * message on failure so the island can surface it and roll back — notably the
 * 409 raised when a `WantToListen` row already exists, which the album page's
 * button state normally prevents but a stale render or a second tab can still
 * hit.
 */
export async function markWantToListen(
  token: string | null,
  albumId: string,
): Promise<WantToListenRow> {
  const response = await fetch(`${getApiBaseUrl()}/want-to-listen`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ albumId }),
  });
  if (!response.ok) {
    await throwApiError(
      response,
      "Could not add this album to your want-to-listen list.",
    );
  }
  return (await response.json()) as WantToListenRow;
}

/**
 * Removes the caller's own want-to-listen entry for an album. Addressed BY ALBUM
 * (not by entry id) because the API scopes the delete to the caller's own row,
 * so a caller can only ever remove their own — someone else's entry, or an album
 * they never marked, is a 404 whose message is surfaced verbatim.
 */
export async function unmarkWantToListen(
  token: string | null,
  albumId: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/want-to-listen/${encodeURIComponent(albumId)}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!response.ok) {
    await throwApiError(
      response,
      "Could not remove this album from your want-to-listen list.",
    );
  }
}
