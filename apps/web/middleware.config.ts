/**
 * Shared, Clerk-free routing constants for the middleware. Kept importable in
 * unit tests without pulling in `@clerk/nextjs/server` (which needs a request
 * context). The Next `config.matcher` itself must be an inline literal in
 * `middleware.ts` because Next parses it statically at compile time.
 */

/**
 * Route patterns treated as protected. Fase 0 protected only the dashboard;
 * Fase 1 (PR3) adds the profile pages at `/u/[username]`, and PR4 adds the
 * onboarding flow (`/onboarding`) plus the app home (`/home`) — all require a
 * signed-in session. `/home` additionally runs the onboarding-complete gate
 * server-side (see `lib/onboarding.ts`), redirecting unonboarded users to
 * `/onboarding`.
 */
export const protectedRoutePatterns = [
  "/dashboard(.*)",
  "/u(.*)",
  "/onboarding(.*)",
  "/home(.*)",
] as const;
