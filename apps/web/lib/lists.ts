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
 * One attempt at `GET /profile`. Distinguishes a transient failure (network
 * error or non-2xx) — worth retrying — from a successful-but-unparseable body,
 * which is not transient and should not be retried.
 */
async function attemptFetchViewerUserId(
  token: string | null,
): Promise<{ transientFailure: true } | { transientFailure: false; userId: string | null }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/profile`, {
      headers: authHeaders(token),
      cache: "no-store",
    });
    if (!response.ok) {
      return { transientFailure: true };
    }
    const profile = (await response.json()) as { userId?: unknown };
    return {
      transientFailure: false,
      userId: typeof profile.userId === "string" ? profile.userId : null,
    };
  } catch {
    return { transientFailure: true };
  }
}

/**
 * Resolves the viewer's own local `User.id` from `GET /profile`, the only
 * endpoint that exposes it (Clerk's `auth()` yields a Clerk id, and
 * `ListDetail.userId` is a local id — they are not comparable). The list page
 * needs it to decide owner-vs-visitor rendering.
 *
 * Retries once on a transient failure (network error or non-2xx from the
 * profile endpoint) before giving up, so a single blip doesn't needlessly
 * flip every viewer — owner and visitor alike — into "ownership unverified".
 * A successful-but-unparseable body is not retried (it isn't transient).
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
  const first = await attemptFetchViewerUserId(token);
  if (!first.transientFailure) {
    return first.userId;
  }
  const second = await attemptFetchViewerUserId(token);
  return second.transientFailure ? null : second.userId;
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
