/** Personal activity-stream domain constants (PR10). */

/** Default page size for `GET /me/activity` when no `limit` is supplied. */
export const DEFAULT_ACTIVITY_LIMIT = 20;

/** Hard upper bound on the page size, so a caller cannot request an unbounded scan. */
export const MAX_ACTIVITY_LIMIT = 50;

/**
 * UUID shape guard applied to the pagination `cursor` (an `ActivityEvent.id`)
 * BEFORE it reaches a Prisma query, so a malformed cursor surfaces as a clean
 * 400 instead of Postgres' raw "invalid input syntax for type uuid" 500 — the
 * same guard rationale as the tracking module's `UUID_PATTERN`. Kept local to
 * this module (rather than imported from `tracking/`) so the two feature
 * modules stay decoupled, matching the onboarding module's own copy.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
