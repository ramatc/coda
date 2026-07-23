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
