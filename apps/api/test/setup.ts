// Load the metadata polyfill before any NestJS decorated class evaluates.
import "reflect-metadata";
import { config } from "dotenv";
import { INTEGRATION_ENABLED } from "./integration.js";

// Opt-in real-infrastructure specs (see `./integration.ts`) need the real
// connection strings. Load the repo-root `.env` — the same file `load-env.ts`
// reads for the API entrypoints — BEFORE the placeholders below, and without
// overriding anything already exported in the environment. Resolved from the
// cwd, which vitest pins to `apps/api`. Skipped entirely by default, so the
// ordinary suite never depends on a local `.env`.
if (INTEGRATION_ENABLED) {
  config({ path: "../../.env", quiet: true });
}

// The health check never queries the database, but importing `@coda/db`
// constructs a (lazy, unconnected) Prisma client. Provide a placeholder
// connection string so construction is deterministic in CI without a live DB.
process.env.DATABASE_URL ??= "postgresql://coda:coda@localhost:5432/coda";

// Placeholder Clerk secrets so the auth layer boots deterministically in tests
// without real credentials. Token/webhook verification is mocked at the SDK
// boundary, so these values are never used to reach Clerk.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.CLERK_WEBHOOK_SECRET ??= "whsec_placeholder";
