/** Social-graph domain constants (Fase 2 — follows + followed-activity feed). */

/** Default page size for `GET /feed` when no `limit` is supplied. */
export const DEFAULT_FEED_LIMIT = 20;

/** Hard upper bound on the feed page size, so a caller cannot request an unbounded scan. */
export const MAX_FEED_LIMIT = 50;

/**
 * UUID shape guard applied to the feed pagination `cursor` (an `ActivityEvent.id`)
 * BEFORE it reaches a Prisma query, so a malformed cursor surfaces as a clean
 * 400 instead of Postgres' raw "invalid input syntax for type uuid" 500 — the
 * same guard rationale as the activity module's `UUID_PATTERN`. Kept local to
 * this module (rather than imported from `activity/`) so the two feature modules
 * stay decoupled, matching the activity/onboarding modules' own copies.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
