/**
 * Shared, Clerk-free routing constants for the middleware. Kept importable in
 * unit tests without pulling in `@clerk/nextjs/server` (which needs a request
 * context). The Next `config.matcher` itself must be an inline literal in
 * `middleware.ts` because Next parses it statically at compile time.
 */

/**
 * Route patterns treated as protected. Fase 0 protected only the dashboard;
 * Fase 1 (PR3) adds the profile pages at `/u/[username]`, PR4 adds the
 * onboarding flow (`/onboarding`) plus the app home (`/home`), PR7 adds the
 * discover/search page (`/search`), PR9 adds the album detail page
 * (`/albums/[id]`), PR10 adds the personal activity stream (`/activity`),
 * Fase 2 slice 1 PR4 adds the followed-activity feed (`/feed`), and Fase 2
 * slice 2 PR4 adds the list pages (`/lists/new`, `/lists/[id]`) — all require a
 * signed-in session. `/home`, the album page, the activity page, and the list
 * pages additionally run the onboarding-complete gate server-side (see
 * `lib/onboarding.ts`), redirecting unonboarded users to `/onboarding`.
 */
export const protectedRoutePatterns = [
  "/dashboard(.*)",
  "/u(.*)",
  "/onboarding(.*)",
  "/home(.*)",
  "/search(.*)",
  "/albums(.*)",
  "/activity(.*)",
  "/feed(.*)",
  "/lists(.*)",
] as const;
