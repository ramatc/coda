/**
 * In-app Clerk auth routes, shared by the two places that must agree on them:
 * `<ClerkProvider>` in `app/layout.tsx` (client-side components and links)
 * and `clerkMiddleware` in `middleware.ts` (the server-side `auth.protect()`
 * redirect, which never sees the provider's props).
 */
export const SIGN_IN_URL = "/sign-in";
export const SIGN_UP_URL = "/sign-up";

/**
 * Where to land when nothing more specific (like a `redirect_url` query
 * param) applies: `/home` after sign-in (its onboarding gate redirects
 * unonboarded users itself), and `/onboarding` directly after sign-up, since
 * a brand-new account has never completed it.
 */
export const SIGN_IN_FALLBACK_REDIRECT_URL = "/home";
export const SIGN_UP_FALLBACK_REDIRECT_URL = "/onboarding";
