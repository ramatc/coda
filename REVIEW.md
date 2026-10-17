# Review guide

Read `CLAUDE.md` first. Review the diff, not the whole repository.

## What failure looks like here

Prioritize these. They are the bugs that matter in Coda:

- **Data leaks across users**: a query, endpoint, or notification that returns or exposes another user's data (missing `userId` scope, private content in public feeds, wrong Clerk identity).
- **Auth gaps**: an API route reachable without the auth guard, or trusting a client-sent user id instead of the Clerk session.
- **Queue jobs**: BullMQ jobs that are lost, duplicated, or never retried; non-idempotent handlers; job ids with characters BullMQ rejects (`:`).
- **Migrations**: destructive or non-reversible changes to existing data, editing an applied migration, or schema changes without a migration.
- **Contract drift**: `packages/types` schemas and the API or web code disagreeing.
- **Search projection drift**: writes that change indexed data without updating Meilisearch.
- **Unsafe tests**: specs that delete rows they did not create, or run against a non-throwaway database.
- **Docs that lie**: README, `CLAUDE.md`, or comments that no longer match the code.

## Evidence

- Every finding cites `file:line` and explains the concrete input or state that breaks it.
- No findings based only on a name, a guess, or "might be".
- If the same bug class appears in several places, report it once and list every location.

## Severity

- **Important**: one of the failures above, or a bug that reproduces with realistic input. Blocks merge.
- **Nit**: style, naming, small readability. At most 3 per review; skip anything prettier or eslint already enforces.
- **Pre-existing**: problems the diff did not introduce. Report separately; they never block.

## Re-reviews

- After the first pass, review only the new commits.
- Do not repeat findings already reported, fixed, or answered.
- After 3 rounds with Important findings, stop and question the approach instead of the lines.

## Skip

- `pnpm-lock.yaml`, `packages/db/src/generated/`, `.codegraph/`, `openspec/`, `odd/`, `.impeccable/`, `.atl/`, `dist/`, `.next/`

## Summary format

Start with a count, e.g. `2 findings (1 Important, 1 Nit, 0 Pre-existing)`. When there is nothing to fix, say `0 findings` plainly.
