/** Reviews domain constants (Fase 2 slice 3 — review likes + comments). */

/**
 * Maximum length of a review comment (trimmed), beyond which a 400 is returned.
 * Mirrors `ReviewComment.body @db.VarChar(500)`: the DB bound is the belt and
 * this service-level validation is the braces, so an over-long body is a clean
 * 400 instead of a Postgres truncation error.
 */
export const MAX_COMMENT_LENGTH = 500;

/**
 * Zero-width / format code points that `String.prototype.trim()` does NOT
 * remove: U+200B ZERO WIDTH SPACE, U+200C ZERO WIDTH NON-JOINER, U+200D ZERO
 * WIDTH JOINER and U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM). Used ONLY to decide
 * whether a comment body is empty — a body made solely of these renders blank
 * but would otherwise pass a `trim().length === 0` check. Deliberately not a
 * sanitizer: bodies that mix them with real text are stored verbatim.
 */
export const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/g;

/**
 * UUID shape guard applied to a `:id` path param BEFORE it reaches a Prisma
 * query, so a malformed id surfaces as a clean 400 instead of Postgres' raw
 * "invalid input syntax for type uuid" 500 — the same guard rationale as the
 * lists/tracking/social modules' `UUID_PATTERN`. Kept local to this module
 * (rather than imported from a sibling) so the feature modules stay decoupled,
 * matching the codebase's per-module constant duplication.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Popular reviews (public landing page)                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many popular reviews `GET /reviews/popular` returns when the caller does
 * not ask for a size. Twelve fills the landing page's card grid at every
 * breakpoint without a second row of filler.
 */
export const DEFAULT_POPULAR_REVIEW_LIMIT = 12;

/**
 * The hard ceiling on `?limit=`. The endpoint is a bounded top-N read with NO
 * cursor, so this bound is the only thing standing between an anonymous caller
 * and an unbounded scan — it is clamped, never rejected, because an oversized
 * limit is a client mistake rather than an error worth a 400.
 */
export const MAX_POPULAR_REVIEW_LIMIT = 24;

/**
 * The joined `Rating.score` (1-10) a review must meet to be shown publicly.
 * The landing page is an editorial shop window, not a feed: seven is the floor
 * for "this person recommends the record", so a lukewarm or negative review is
 * never the first thing a logged-out visitor reads.
 */
export const POPULAR_REVIEW_MIN_SCORE = 7;
