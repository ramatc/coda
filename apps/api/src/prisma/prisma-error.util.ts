import { Prisma } from "@coda/db";

/** Prisma error code for a unique-constraint violation. */
export const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/** Prisma error code for a foreign-key constraint violation. */
export const FOREIGN_KEY_VIOLATION = "P2003";

/** Prisma error code for "record to update/delete does not exist". */
export const RECORD_NOT_FOUND = "P2025";

/**
 * Extracts the conflicting column name from a P2002 error thrown by this
 * project's Prisma 7 client, which ALWAYS runs on the `@prisma/adapter-pg`
 * driver adapter and therefore never populates the "classic" `err.meta.target`.
 *
 * The real shape (verified against the installed
 * `@prisma/adapter-pg`/`@prisma/driver-adapter-utils` packages and the
 * generated client at `packages/db/src/generated/client/runtime/client.js`):
 * `@prisma/adapter-pg`'s `mapDriverError` builds
 * `{ kind: "UniqueConstraintViolation", constraint: { fields: [...] } }` for
 * Postgres error code `23505`; `@prisma/driver-adapter-utils`'s
 * `DriverAdapterError` stores that payload verbatim on `.cause`; the generated
 * client re-throws it as `PrismaClientKnownRequestError` with
 * `meta: { driverAdapterError: <that error> }`.
 *
 * This is the SINGLE source of truth for driver-adapter P2002 attribution in
 * the API (Decision #14, PR2 judgment-day Round 3/4). Any new P2002 handling
 * MUST reuse this helper rather than reintroducing the wrong `meta.target` path.
 */
export function extractUniqueConstraintField(
  err: Prisma.PrismaClientKnownRequestError,
): string | undefined {
  const driverAdapterError = err.meta?.driverAdapterError;
  if (typeof driverAdapterError !== "object" || driverAdapterError === null) {
    return undefined;
  }
  const cause = (driverAdapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const constraint = (cause as { constraint?: unknown }).constraint;
  if (typeof constraint !== "object" || constraint === null) {
    return undefined;
  }
  const fields = (constraint as { fields?: unknown }).fields;
  return Array.isArray(fields) && typeof fields[0] === "string"
    ? fields[0]
    : undefined;
}

/**
 * Type guard for a P2002 unique-constraint violation from this project's Prisma
 * client.
 */
export function isUniqueConstraintViolation(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

/**
 * Type guard for a P2003 foreign-key-constraint violation from this project's
 * Prisma client. Hoisted here (judgment-day issue #5, Round 3) so both
 * `catalog-import.service.ts` and `catalog-worker.ts` share a single source of
 * truth instead of each redeclaring `const FOREIGN_KEY_VIOLATION = "P2003"`
 * locally.
 */
export function isForeignKeyViolation(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === FOREIGN_KEY_VIOLATION
  );
}

/**
 * Type guard for a P2025 "record not found" error from this project's Prisma
 * client — thrown by `update`/`delete` when the targeted row is gone by the
 * time the query runs (e.g. a concurrent delete won the race between a
 * pre-check and the write itself; judgment-day PR8 round 2, issue #1).
 */
export function isRecordNotFound(
  err: unknown,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === RECORD_NOT_FOUND
  );
}
