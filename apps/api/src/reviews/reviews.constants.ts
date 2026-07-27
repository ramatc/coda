/** Reviews domain constants (Fase 2 slice 3 — review likes + comments). */

/**
 * Maximum length of a review comment (trimmed), beyond which a 400 is returned.
 * Mirrors `ReviewComment.body @db.VarChar(500)`: the DB bound is the belt and
 * this service-level validation is the braces, so an over-long body is a clean
 * 400 instead of a Postgres truncation error.
 */
export const MAX_COMMENT_LENGTH = 500;

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
