/** Notifications domain constants (Fase 2 slice 4 — in-app notifications). */

/** Default page size for `GET /notifications` when no `limit` is supplied. */
export const DEFAULT_NOTIFICATION_LIMIT = 20;

/**
 * Hard upper bound on the page size, so a caller cannot request an unbounded
 * scan. Deliberately aligned with `MAX_FEED_LIMIT` / `MAX_ACTIVITY_LIMIT`: all
 * three surfaces are the same cursor-paginated card list, and a divergent
 * ceiling here would be a difference with no reason behind it.
 */
export const MAX_NOTIFICATION_LIMIT = 50;

/**
 * How much of a comment body rides along in a COMMENT notification item. The
 * dropdown shows a one-line preview, so the full body (up to
 * `MAX_COMMENT_LENGTH` = 500) would be ~4x the payload for no rendered benefit.
 * Truncation is a plain cut with no ellipsis — the API returns data, and the
 * "…" affordance is the web layer's styling decision.
 */
export const COMMENT_EXCERPT_LENGTH = 140;

/**
 * UUID shape guard applied to the pagination `cursor` (a `Notification.id`)
 * BEFORE it reaches a Prisma query, so a malformed cursor surfaces as a clean
 * 400 instead of Postgres' raw "invalid input syntax for type uuid" 500 — the
 * same guard rationale as the social/activity modules' `UUID_PATTERN`. Kept
 * local to this module (rather than imported from a sibling) so the feature
 * modules stay decoupled, matching the codebase's per-module constant
 * duplication convention.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
