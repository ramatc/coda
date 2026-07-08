import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { protectedRoutePatterns } from "./middleware.config";

/**
 * Clerk middleware. Only `/dashboard(.*)` is protected in Fase 0: matched
 * requests from unauthenticated visitors are redirected to Clerk's sign-in by
 * `auth.protect()`. Everything else (including `/`) stays public.
 */
const isProtectedRoute = createRouteMatcher([...protectedRoutePatterns]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

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
