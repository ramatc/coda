/**
 * Shared, Clerk-free routing constants for the middleware. Kept importable in
 * unit tests without pulling in `@clerk/nextjs/server` (which needs a request
 * context). The Next `config.matcher` itself must be an inline literal in
 * `middleware.ts` because Next parses it statically at compile time.
 */

/**
 * Route patterns treated as protected (signed-in session required). Fase 0
 * protected only the dashboard; Fase 1 (PR3) adds the profile pages at
 * `/u/[username]`, PR4 adds the onboarding flow (`/onboarding`) plus the app
 * home (`/home`), PR7 adds the discover/search page (`/search`), PR10 adds the
 * personal activity stream (`/activity`), Fase 2 slice 1 PR4 adds the
 * followed-activity feed (`/feed`), and slice 2 PR4 adds the viewer's own lists
 * (`/lists`) and the create-list form (`/lists/new`).
 *
 * Deliberately ABSENT, because they are public and indexable: the album detail
 * page (`/albums/[id]`), the list detail page (`/lists/[id]`, where the API
 * answers a private list with 404), and the review detail page
 * (`/reviews/[id]`). The album and list pages skip the onboarding gate for an
 * anonymous visitor and still run it for a signed-in one (see
 * `lib/onboarding.ts`); the review page never runs it. `/lists` is matched
 * EXACTLY so it does not cover `/lists/[id]`. `app/robots.ts` derives its
 * disallow list from these patterns.
 */
export const protectedRoutePatterns = [
  "/dashboard(.*)",
  "/u(.*)",
  "/onboarding(.*)",
  "/home(.*)",
  "/search(.*)",
  "/activity(.*)",
  "/feed(.*)",
  "/lists",
  "/lists/new(.*)",
] as const;
