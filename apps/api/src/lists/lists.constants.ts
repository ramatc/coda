/** Lists domain constants (Fase 2 slice 2 — curated album lists + reorder). */

/** Maximum length of a list title (trimmed), beyond which a 400 is returned. */
export const MAX_TITLE_LENGTH = 120;

/** Maximum length of a list description (trimmed), beyond which a 400 is returned. */
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Maximum length of a per-item note (trimmed), beyond which a 400 is returned. */
export const MAX_NOTE_LENGTH = 2000;

/**
 * UUID shape guard applied to a `:id` path param BEFORE it reaches a Prisma
 * query, so a malformed id surfaces as a clean 400 instead of Postgres' raw
 * "invalid input syntax for type uuid" 500 — the same guard rationale as the
 * tracking/social modules' `UUID_PATTERN`. Kept local to this module (rather
 * than imported from a sibling) so the feature modules stay decoupled, matching
 * the codebase's per-module constant duplication.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Popular lists (public landing page)                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many popular lists `GET /lists/popular` returns when the caller does not
 * ask for a size. Six fills the landing page's list row (two rows of three, or
 * one scroll strip on mobile) without a thin trailing row.
 */
export const DEFAULT_POPULAR_LIST_LIMIT = 6;

/**
 * The hard ceiling on `?limit=`. The endpoint is a bounded top-N read with NO
 * cursor, so this bound is the only thing standing between an anonymous caller
 * and an unbounded scan — it is clamped, never rejected, because an oversized
 * limit is a client mistake rather than an error worth a 400.
 */
export const MAX_POPULAR_LIST_LIMIT = 12;

/**
 * The minimum number of items a public list needs to be shown on the landing
 * page. A one- or two-album list reads as abandoned in a showcase, and the
 * card's cover collage needs a few covers to look like a collection at all.
 */
export const POPULAR_LIST_MIN_ITEMS = 3;

/**
 * How many candidate rows `popularLists` reads per list it intends to return.
 * Prisma cannot filter on `_count` in a `where`, so the item floor is applied
 * in memory AFTER the read; reading `limit * 3` candidates leaves headroom for
 * sparse lists without scanning the table. Bounded by construction: the limit
 * is already clamped to {@link MAX_POPULAR_LIST_LIMIT}, so the window never
 * exceeds 36 rows.
 */
export const POPULAR_LIST_CANDIDATE_FACTOR = 3;

/**
 * How many album covers a popular-list card previews in its collage. Read with
 * a nested `take` so a card never loads its whole item list.
 */
export const LIST_PREVIEW_COVER_COUNT = 4;
