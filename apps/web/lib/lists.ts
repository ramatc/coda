import { getApiBaseUrl } from "./api-client";

/** The album denormalized onto a list item, as returned by the API. */
export interface ListItemAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** One item on a list, in its stored `position` order (mirrors `ListItemView`). */
export interface ListItem {
  id: string;
  position: number;
  note: string | null;
  album: ListItemAlbum;
}

/** The `GET /lists/:id` payload: the list plus its ordered items. */
export interface ListDetail {
  id: string;
  /** The OWNER's local `User.id` — compared against {@link fetchViewerUserId}. */
  userId: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  items: ListItem[];
}

/**
 * A compact list row from `GET /users/:username/lists` — the list WITHOUT its
 * items, plus an `itemCount`. Mirrors the API's own `ListSummary` exactly. The
 * album page's "add to list" picker only needs `id` + `title` to label an
 * option, but the shape is kept faithful to the payload so the type never drifts
 * from what the endpoint actually sends (the same posture {@link ListDetail}
 * takes) — it is still far lighter than a `ListDetail` per list, which would
 * mean shipping every item of every list to render a `<select>`.
 */
export interface ListSummary {
  id: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The viewer's own identity as `GET /profile` reports it: the LOCAL `User.id`
 * (see {@link fetchViewerUserId}) plus the `username` the public routes are
 * keyed by (`/users/:username/lists`, `/u/[username]`).
 */
export interface ViewerProfile {
  userId: string;
  username: string;
}

/** The full payload accepted by `POST /lists`. */
export interface CreateListInput {
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
}

/** A partial patch accepted by `PATCH /lists/:id` (the API rejects an empty one). */
export interface UpdateListInput {
  title?: string;
  description?: string | null;
  isRanked?: boolean;
  isPublic?: boolean;
}

/**
 * Sentinel distinguishing a 404 from a transport error, mirroring
 * `ALBUM_NOT_FOUND` in `lib/albums.ts`. The API deliberately answers 404 (not
 * 403) for a PRIVATE list a visitor may not see, so this single sentinel covers
 * both "no such list" and "not yours to see" — exactly what the page needs to
 * render `notFound()` without leaking the list's existence.
 */
export const LIST_NOT_FOUND = Symbol("list-not-found");

/**
 * Empty-state copy for a list with no albums. Shared by the visitor's read-only
 * rendering and the owner's reorder island so the two never drift, and kept
 * HERE (rather than in either component) because those two live on opposite
 * sides of the server/client boundary.
 */
export const EMPTY_LIST_MESSAGE = "No albums on this list yet.";

/**
 * True when the viewer owns the list. `viewerUserId` is the viewer's LOCAL
 * `User.id` (see {@link fetchViewerUserId}), which is what `ListDetail.userId`
 * carries — a Clerk id would never match. An unresolved viewer (`null`) is
 * deliberately NOT the owner, so the UI degrades to read-only rather than
 * offering controls the API would reject.
 */
export function isListOwner(
  list: Pick<ListDetail, "userId">,
  viewerUserId: string | null,
): boolean {
  return viewerUserId !== null && viewerUserId === list.userId;
}

/** Auth-only headers for reads. */
function authHeaders(token: string | null): Record<string, string> {
  return { Authorization: `Bearer ${token ?? ""}` };
}

/** Auth + JSON headers for write paths that carry a body. */
function jsonHeaders(token: string | null): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

/**
 * Reads the API's own error `message` so the UI surfaces the backend's wording
 * ("This album is already on the list.", "You do not own this list.",
 * "itemIds must list every item on the list exactly once.") instead of guessing
 * from the status code. Falls back to `generic` when the body is not JSON or
 * carries no string `message` — Nest also emits `message` as a string ARRAY for
 * some validation errors, which is deliberately NOT surfaced raw.
 *
 * Unlike `lib/albums.ts`, there is no `ACCOUNT_NOT_SYNCED` branch here: the
 * lists module throws a plain `NotFoundException("No local account for the
 * current user.")` without the stable `code` discriminator that the tracking and
 * recommendations modules attach, so there is nothing to key the friendly
 * "still syncing" copy off. Its raw message is surfaced like any other.
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

/** Parses a successful JSON response as a {@link ListDetail}. */
async function readListDetail(response: Response): Promise<ListDetail> {
  return (await response.json()) as ListDetail;
}

/**
 * Fetches a list with its ordered items, server-side, with the viewer's Clerk
 * token. Returns {@link LIST_NOT_FOUND} for a 404 (unknown OR private-to-this-
 * viewer) so the page can render `notFound()`, and throws for any other non-OK
 * response — same posture as `fetchAlbumDetail`.
 */
export async function fetchList(
  token: string | null,
  id: string,
): Promise<ListDetail | typeof LIST_NOT_FOUND> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(id)}`,
    { headers: authHeaders(token), cache: "no-store" },
  );
  if (response.status === 404) {
    return LIST_NOT_FOUND;
  }
  if (!response.ok) {
    throw new Error(`Failed to load list (${response.status})`);
  }
  return readListDetail(response);
}

/**
 * The fields of `GET /profile` this module reads, each independently `null`
 * when absent or not a string. Kept as two loose fields rather than a
 * {@link ViewerProfile} so {@link fetchViewerUserId} — which needs only the id
 * — is never made stricter by a caller that also wants the username.
 */
interface ParsedProfile {
  userId: string | null;
  username: string | null;
}

/** The unresolved profile: what every failing path degrades to. */
const NO_PROFILE: ParsedProfile = { userId: null, username: null };

/**
 * One attempt at `GET /profile`. Distinguishes a transient failure (network
 * error, or a 5xx) — worth retrying — from a deterministic one. A 4xx
 * (401/403/404/...) would return the identical result on a second attempt,
 * so it is treated as definitive, not transient. A successful-but-unparseable
 * body is likewise not transient and should not be retried.
 */
async function attemptFetchProfile(
  token: string | null,
): Promise<
  { transientFailure: true } | { transientFailure: false; profile: ParsedProfile }
> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/profile`, {
      headers: authHeaders(token),
      cache: "no-store",
    });
  } catch {
    return { transientFailure: true };
  }
  if (!response.ok) {
    // Only a 5xx is worth a second attempt; a 4xx is deterministic and
    // retrying it would just add latency for the identical result.
    if (response.status >= 500) {
      return { transientFailure: true };
    }
    return { transientFailure: false, profile: NO_PROFILE };
  }
  try {
    const profile = (await response.json()) as {
      userId?: unknown;
      username?: unknown;
    };
    return {
      transientFailure: false,
      profile: {
        userId: typeof profile.userId === "string" ? profile.userId : null,
        username: typeof profile.username === "string" ? profile.username : null,
      },
    };
  } catch {
    return { transientFailure: false, profile: NO_PROFILE };
  }
}

/**
 * Reads `GET /profile`, retrying ONCE on a transient failure (network error or
 * a 5xx) before giving up, so a single blip doesn't needlessly degrade every
 * caller. A 4xx (deterministic) or a successful-but-unparseable body is not
 * retried — neither is transient. Always resolves; never throws.
 */
async function fetchProfileWithRetry(
  token: string | null,
): Promise<ParsedProfile> {
  const first = await attemptFetchProfile(token);
  if (!first.transientFailure) {
    return first.profile;
  }
  const second = await attemptFetchProfile(token);
  return second.transientFailure ? NO_PROFILE : second.profile;
}

/**
 * Resolves the viewer's own local `User.id` from `GET /profile`, the only
 * endpoint that exposes it (Clerk's `auth()` yields a Clerk id, and
 * `ListDetail.userId` is a local id — they are not comparable). The list page
 * needs it to decide owner-vs-visitor rendering.
 *
 * Retries once on a transient failure (network error or a 5xx from the
 * profile endpoint) before giving up, so a single blip doesn't needlessly
 * flip every viewer — owner and visitor alike — into "ownership unverified".
 * A 4xx (deterministic) or a successful-but-unparseable body is not retried
 * (neither is transient).
 *
 * Fails safe to `null` (→ the page renders as a VISITOR, hiding owner-only
 * controls) rather than throwing during render: degrading to read-only is the
 * safe direction, since every owner action is re-authorized server-side anyway.
 * A `null` here (persistent network error, non-OK response, or a malformed
 * body) is indistinguishable from a legitimate "not the owner" to
 * {@link isListOwner}, so the list page treats it as "ownership unverified"
 * and surfaces a visible notice rather than silently rendering as a
 * definitive visitor.
 */
export async function fetchViewerUserId(
  token: string | null,
): Promise<string | null> {
  return (await fetchProfileWithRetry(token)).userId;
}

/**
 * Resolves the viewer's own id AND username from the same `GET /profile` call
 * {@link fetchViewerUserId} uses — the album page needs the username to ask
 * `GET /users/:username/lists` for the caller's OWN lists, and Clerk's `auth()`
 * exposes neither. Kept separate from {@link fetchViewerUserId} (rather than
 * replacing it) because the list page only ever compares ids, and widening its
 * contract would make it fail on a payload it currently handles fine.
 *
 * Fails safe to `null` — persistent network error, non-OK response, malformed
 * body, or a body missing either field — so a profile blip degrades the album
 * page's picker to empty instead of throwing during render. That empty state is
 * therefore ambiguous between "you have no lists" and "we could not load them";
 * the once-retry inherited from {@link fetchProfileWithRetry} keeps that case
 * rare, and the hint it renders (create a list) is harmless either way.
 */
export async function fetchViewerProfile(
  token: string | null,
): Promise<ViewerProfile | null> {
  const { userId, username } = await fetchProfileWithRetry(token);
  return userId !== null && username !== null ? { userId, username } : null;
}

/**
 * Fetches the lists shown on `username`'s profile: the API returns ALL of them
 * when the caller IS that user, and only the public ones otherwise — so calling
 * it with the viewer's own username (see {@link fetchViewerProfile}) yields
 * exactly the lists they may add an album to.
 *
 * Fails safe to an EMPTY array on any failure — network error, non-OK response,
 * or a body that isn't an array — rather than throwing during render, matching
 * `fetchWantToListen`'s posture: a picker that is briefly empty is a far better
 * outcome than an album page that refuses to render.
 */
export async function fetchUserLists(
  token: string | null,
  username: string,
): Promise<ListSummary[]> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/users/${encodeURIComponent(username)}/lists`,
      { headers: authHeaders(token), cache: "no-store" },
    );
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as ListSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * The lists the VIEWER may add an album to: their own, public and private
 * alike. Chains {@link fetchViewerProfile} (to learn the viewer's username,
 * which no client-side source exposes) into {@link fetchUserLists} keyed by that
 * username. An unresolved viewer short-circuits to an empty array WITHOUT a
 * second request — there would be no username to build a URL from.
 *
 * Composed here rather than in the album page so the "unresolved viewer → empty
 * picker" rule is testable on its own and stays identical wherever a caller's
 * own lists are needed. Never throws: the album page must render regardless.
 */
export async function fetchViewerOwnLists(
  token: string | null,
): Promise<ListSummary[]> {
  const profile = await fetchViewerProfile(token);
  return profile === null ? [] : fetchUserLists(token, profile.username);
}

/** Creates a list owned by the caller. Throws with the API's message on failure. */
export async function createList(
  token: string | null,
  input: CreateListInput,
): Promise<ListDetail> {
  const response = await fetch(`${getApiBaseUrl()}/lists`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    await throwApiError(response, "Could not create the list.");
  }
  return readListDetail(response);
}

/**
 * Edits the caller's own list. Only the supplied keys are sent, matching the
 * API's partial-patch contract (an empty patch is a 400 server-side).
 */
export async function updateList(
  token: string | null,
  id: string,
  input: UpdateListInput,
): Promise<ListDetail> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) {
    await throwApiError(response, "Could not save the list.");
  }
  return readListDetail(response);
}

/** Deletes the caller's own list (the API answers 204 and cascades its items). */
export async function deleteList(
  token: string | null,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!response.ok) {
    await throwApiError(response, "Could not delete the list.");
  }
}

/**
 * Adds an album to the caller's own list, appended last. A duplicate album is a
 * 409 whose message ("This album is already on the list.") is surfaced verbatim.
 */
export async function addListItem(
  token: string | null,
  listId: string,
  albumId: string,
  note: string | null = null,
): Promise<ListDetail> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(listId)}/items`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ albumId, note }),
    },
  );
  if (!response.ok) {
    await throwApiError(response, "Could not add this album to the list.");
  }
  return readListDetail(response);
}

/**
 * Removes an item from the caller's own list. The item is addressed UNDER its
 * list (`/lists/:id/items/:itemId`) because the API scopes the delete by both
 * ids; the response is the already-renumbered list.
 */
export async function removeListItem(
  token: string | null,
  listId: string,
  itemId: string,
): Promise<ListDetail> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE", headers: authHeaders(token) },
  );
  if (!response.ok) {
    await throwApiError(response, "Could not remove this item.");
  }
  return readListDetail(response);
}

/**
 * Sends the FULL desired order of a list's items. The API owns renumbering: it
 * validates that `itemIds` is a permutation of the list's current items (400 on
 * a mismatch) and assigns `position = index + 1`. A concurrent change to the
 * list surfaces as a 409 whose retry message is passed through.
 */
export async function reorderListItems(
  token: string | null,
  listId: string,
  itemIds: string[],
): Promise<ListDetail> {
  const response = await fetch(
    `${getApiBaseUrl()}/lists/${encodeURIComponent(listId)}/items/reorder`,
    {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify({ itemIds }),
    },
  );
  if (!response.ok) {
    await throwApiError(response, "Could not save the new order.");
  }
  return readListDetail(response);
}
