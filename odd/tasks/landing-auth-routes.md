# Landing auth routes

## Objective
Make the landing "Sign in" / "Sign up" / "Get started" links work by adding in-app Clerk auth routes.

## Problem
`hero.tsx`, `public-header.tsx`, and `final-cta.tsx` link to `/sign-in` and `/sign-up`, but no such routes exist in `apps/web/app` → 404. Protected routes currently bounce to Clerk's hosted Account Portal via `auth.protect()`.

## Why
User decision (2026-09-27): own branded routes instead of Clerk `<SignInButton>`/`<SignUpButton>` redirects.

## Scope / constraints
- Add `app/sign-in/[[...sign-in]]/page.tsx` (`<SignIn />`) and `app/sign-up/[[...sign-up]]/page.tsx` (`<SignUp />`).
- Configure `<ClerkProvider>` in `app/layout.tsx` with `signInUrl`/`signUpUrl` in code (no `.env` edits) so `auth.protect()` redirects to the in-app routes too.
- Post sign-in fallback → `/home` (onboarding gate handles unonboarded users); post sign-up fallback → `/onboarding`.
- Auth routes must stay public (not in `protectedRoutePatterns`).
- Landing links keep pointing at `/sign-in` / `/sign-up`.
- `review-sign-in-prompt.tsx` keeps working (its doc comment claiming "no /sign-in route" must be updated).

## TDD
Mode: enabled (Strict TDD, global session config). Runner: `pnpm --filter web test` (vitest).

## Tasks
- [x] T1 — Add in-app sign-in/sign-up routes and wire ClerkProvider URLs (route: delegated direct — writer trigger, 2+ non-trivial files; parent spot-check follow-up inline)
  - Evidence: RED — new page tests failed on missing `page` imports; `middleware-auth-urls.test.ts` failed (clerkMiddleware called without options). GREEN — `pnpm --filter web test` 572/572 (58 files); typecheck clean; lint clean.
  - Parent review found `auth.protect()` ignores `<ClerkProvider>` props (clerkMiddleware resolves `signInUrl` from its own options or `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `@clerk/nextjs@7.5.14` `dist/esm/server/clerkMiddleware.js:136`). Added the options to `clerkMiddleware` in `middleware.ts` and corrected the layout comment.

## Acceptance criteria
- `/sign-in` and `/sign-up` render Clerk components in the app's dark shell.
- Unauthenticated visit to a protected route redirects to `/sign-in`.
- Auth routes are not matched as protected.
- web tests, typecheck, and lint pass.

## Checks
`pnpm --filter web test`, `pnpm --filter web typecheck`, `pnpm --filter web lint`

## Delivery
Strategy: ask-on-risk. Forecast: well under 400 authored lines → single PR.

## Progress
- Engram mirror `odd/landing-auth-routes/tasks`: PENDING (Engram MCP disconnected this session).
