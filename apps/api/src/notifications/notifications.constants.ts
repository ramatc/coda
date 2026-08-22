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

/**
 * Env var: Resend API key. Unset ⇒ {@link ResendService} is DISABLED and every
 * send is a logged no-op. This is a deliberate divergence from `MeiliService`,
 * which falls back to sending unauthenticated when its key is missing: there is
 * no keyless Resend, so "no key" means *disabled*, not *anonymous*. Expected to
 * be unset in dev and CI; provisioning it is what turns production email on.
 */
export const RESEND_API_KEY_ENV = "RESEND_API_KEY";

/**
 * Env var: the `from` address every notification email is sent as (Resend
 * accepts either a bare address or `Name <address>`). Resend rejects a send
 * with no sender, so a client holding a key but no sender could only ever
 * produce 422s — it is treated as disabled too, and the construction-time warn
 * names whichever variable is missing.
 */
export const RESEND_FROM_ENV = "RESEND_FROM_EMAIL";
