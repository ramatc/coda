import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { protectedRoutePatterns } from "./middleware.config";

/**
 * Clerk middleware. Protected routes are defined by `protectedRoutePatterns`
 * in `middleware.config.ts` — the single source of truth for what's gated —
 * matched requests from unauthenticated visitors are redirected to the in-app
 * `/sign-in` route by `auth.protect()`. Everything else (including `/`) stays
 * public.
 *
 * `signInUrl`/`signUpUrl` MUST be set here, not only on `<ClerkProvider>`:
 * `auth.protect()` resolves its redirect on the server from these options (or
 * the `NEXT_PUBLIC_CLERK_SIGN_IN_URL` env var) and never sees the provider's
 * client-side props. Without them it falls back to Clerk's hosted Account
 * Portal.
 */
const isProtectedRoute = createRouteMatcher([...protectedRoutePatterns]);

export default clerkMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
  },
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

// NOTE: Next statically parses `config.matcher`, so it MUST be an inline
// literal here (imported constants are rejected by the compiler).
export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
