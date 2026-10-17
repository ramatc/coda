# Coda

Music-tracking social app. pnpm + Turborepo monorepo. Product and architecture: `README.md` and `docs/coda_especificacion_tecnica.md`.

## Layout

- `apps/api` — NestJS API (Clerk auth, Prisma, BullMQ workers, Meilisearch, S3). One folder per module under `src/`.
- `apps/web` — Next.js App Router + Tailwind + Clerk.
- `packages/db` — Prisma schema, migrations, generated client.
- `packages/types` — shared zod schemas and types (the API/web contract).
- `packages/ui` — shared React components. `packages/config` — eslint/tsconfig/vitest presets.

## Checks you can run

```sh
pnpm turbo lint typecheck build test   # what CI runs; must pass before a PR
pnpm format:check                       # prettier
pnpm --filter @coda/db exec prisma validate
pnpm --filter <pkg> exec vitest run <path>   # focused test
```

Real-infrastructure specs (`*.postgres.spec.ts`, `*.redis.spec.ts`) skip unless `CODA_INTEGRATION=1` and a migrated database is reachable:

```sh
CODA_INTEGRATION=1 pnpm --filter @coda/api exec vitest run .postgres.spec .redis.spec
```

## Rules

- Never run destructive SQL, `prisma migrate reset`, or row-deleting specs against the local `coda` database. Use a throwaway database whose name contains a `test` or `scratch` segment (see `apps/api/test/integration.ts`). Back up with `pg_dump` before any DB work.
- Schema changes go through a new Prisma migration in `packages/db/prisma/migrations`; never edit an applied migration.
- API request/response shapes live in `packages/types`; change them there, not inline in `apps/*`.
- Tests use in-memory fakes by default; only `*.postgres.spec.ts` / `*.redis.spec.ts` touch real infrastructure.
- Conventional Commits; small PRs (about 400 changed lines); fill in the PR template.

## Non-goals

- No cloud deploy pipeline in this repo yet; CI only verifies.

## Review

Reviewers (human or agent) follow `REVIEW.md`. If a change makes a line in this file outdated, update it in the same PR.
