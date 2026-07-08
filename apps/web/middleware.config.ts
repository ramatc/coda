/**
 * Shared, Clerk-free routing constants for the middleware. Kept importable in
 * unit tests without pulling in `@clerk/nextjs/server` (which needs a request
 * context). The Next `config.matcher` itself must be an inline literal in
 * `middleware.ts` because Next parses it statically at compile time.
 */

/** Route patterns treated as protected. Fase 0 protects only the dashboard. */
export const protectedRoutePatterns = ["/dashboard(.*)"] as const;
