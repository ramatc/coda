/** Want-to-listen domain constants (Fase 2 slice 2 — manual backlog). */

/**
 * UUID shape guard applied to an `albumId` (body or `:albumId` path param)
 * BEFORE it reaches a Prisma query, so a malformed id surfaces as a clean 400
 * instead of Postgres' raw "invalid input syntax for type uuid" 500 — the same
 * guard rationale as the tracking/lists modules' `UUID_PATTERN`. Kept local to
 * this module (rather than imported from a sibling) so the feature modules stay
 * decoupled, matching the codebase's per-module constant duplication.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
