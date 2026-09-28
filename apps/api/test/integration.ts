/**
 * Opt-in switch for specs that talk to REAL infrastructure (Postgres, Redis)
 * instead of the in-memory fakes the rest of the suite uses.
 *
 * Such specs wrap themselves in `describe.skipIf(!INTEGRATION_ENABLED)`, so a
 * plain `vitest run` reports them as SKIPPED rather than failing when no
 * migrated database or Redis is reachable. The flag is explicit on purpose:
 * CI exports `DATABASE_URL`/`REDIS_URL` but runs tests BEFORE
 * `prisma migrate deploy`, so the mere presence of a connection string is not
 * a signal that the schema exists. A dedicated CI step sets the flag after the
 * migrations are applied.
 *
 * Integration spec files are named `*.postgres.spec.ts` / `*.redis.spec.ts`.
 */
export const INTEGRATION_ENV = "CODA_INTEGRATION";

export const INTEGRATION_ENABLED = process.env[INTEGRATION_ENV] === "1";
