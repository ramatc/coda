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

/** A database name segment (split on `_` or `-`) that marks a disposable copy. */
const THROWAWAY_NAME_SEGMENT = /(^|[_-])(test|scratch)([_-]|$)/i;

/**
 * Whether it is safe for a spec to DELETE rows it did not create itself.
 * Decided by the database name alone: it qualifies when any segment of the
 * name, split on `_` or `-`, is exactly `test` or `scratch` (`coda_test`,
 * `coda_scratch`, `scratch-db`). The everyday `coda` database never does, and
 * an unparseable URL is refused. The `CI` flag is deliberately ignored: shells
 * and tools export it too, and CI names its database `coda_test` instead.
 */
export function isThrowawayDatabase(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return name.length > 0 && THROWAWAY_NAME_SEGMENT.test(name);
  } catch {
    return false;
  }
}
