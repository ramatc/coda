# Public album and list pages (SEO, first step)

Objective: let anonymous visitors and search engines view album pages and public list pages; everything else stays behind login.
Branch: `feat/public-album-list-pages` (worktree `../coda-worktrees/public-pages`). Delivery: ask-on-risk. Test runner: vitest.

## Specs

- S1. Album detail pages (`/albums/[id]`) are viewable without signing in. The API read `GET /albums/:id` answers anonymous callers with the shared album data and an empty viewer state.
- S2. Public list detail pages (`/lists/[id]`) are viewable without signing in. `GET /lists/:id` answers anonymous callers for public lists; private lists stay 404 for anyone but the owner.
- S3. Everything else stays behind login, including `/lists` (own lists), `/lists/new`, `/u/...`, and every write endpoint. Write endpoints keep rejecting anonymous callers.
- S4. Anonymous visitors see sign-in prompts instead of user controls (listen, rate, review, backlog, add-to-list, list like) and never see owner-only controls or the "ownership unverified" notice.
- S5. Signed-in behavior is unchanged: onboarding gate, viewer state, owner controls.
- S6. Album and public list pages are indexable: per-page `<title>`, description and canonical URL; a `robots.ts`; `metadataBase` from a new web env var for the site URL.
- Assumption: a `sitemap.ts` is out of scope for this step (it needs a new API listing endpoint); recorded as a follow-up.

## Tasks

- [x] T1 S1-S3 API: `@Public()` + `OptionalClerkGuard` on `GET /albums/:id` and `GET /lists/:id` only; anonymous short-circuits in `AlbumDetailService.resolveViewerState` and `ListsService.resolveUserId`. Route: inline. Risk: item 2 (opens auth on two reads).
- [ ] T2 S1-S5 Web: middleware keeps `/lists` and `/lists/new` protected, frees `/albums/...` and `/lists/[id]`; pages skip the onboarding gate only when signed out; anonymous branches in album actions and list detail. Route: inline. Risk: item 2.
- [ ] T3 S6 SEO: `generateMetadata` on both pages, `metadataBase`, `robots.ts`, new env var in `.env.example` and docs. Route: inline.

## Log

- L1 (2026-10-17, user): "Y no hay nada mas pendiente de otras tareas que se pueda seguir sin eso? De otras fases? Revisa en coda_especificacion_tecnica.md#12-roadmap-por-fases" — then "Dale" to starting SEO with only album pages and public lists, leaving profiles `/u/...` and standalone reviews for a later step.
- L2: explorer map. `ClerkGuard` is a global fail-closed `APP_GUARD`; `/reviews/[id]` is the precedent for an anonymous page (`@Public` + `OptionalClerkGuard`, onboarding gate skipped, sign-in prompts). `fetchOnboardingStatus` treats a non-OK response as incomplete, so anonymous visitors would be redirected to `/onboarding` today. `findUnique({ clerkUserId: undefined })` needs a short-circuit.
- Next: T1.
