/** Album-tracking domain constants (PR8). */

/** Inclusive lower bound for a `Rating.score` (design Decision #11). */
export const MIN_SCORE = 1;
/** Inclusive upper bound for a `Rating.score` (design Decision #11). */
export const MAX_SCORE = 10;

/**
 * Exact out-of-range validation message mandated by design Decision #11 /
 * spec (`album-tracking` → Rating). This string is a contract — the web client
 * and any consumer match on it, so it is intentionally NOT localized to the
 * repo's default English error copy.
 */
export const SCORE_RANGE_ERROR = "El campo 'score' debe estar entre 1 y 10.";

/**
 * UUID shape guard applied to `albumId`/`listenId` BEFORE they reach a Prisma
 * query, so a malformed id surfaces as a clean 400 instead of Postgres'
 * raw "invalid input syntax for type uuid" 500 (same guard rationale as the
 * onboarding module's `UUID_PATTERN`).
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
