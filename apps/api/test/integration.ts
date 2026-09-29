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
 * Whether it is safe for a spec to DELETE rows it did not create itself. Only
 * CI (an ephemeral service container) and databases named as disposable
 * copies (`coda_test`, `coda_scratch`) qualify; the everyday development
 * database never does, and an unparseable URL is refused.
 */
export function isThrowawayDatabase(
  databaseUrl: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (env.CI === "true") return true;
  if (!databaseUrl) return false;
  try {
    const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    return name.length > 0 && THROWAWAY_NAME_SEGMENT.test(name);
  } catch {
    return false;
  }
}
