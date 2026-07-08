// Load the metadata polyfill before any NestJS decorated class evaluates.
import "reflect-metadata";

// The health check never queries the database, but importing `@coda/db`
// constructs a (lazy, unconnected) Prisma client. Provide a placeholder
// connection string so construction is deterministic in CI without a live DB.
process.env.DATABASE_URL ??= "postgresql://coda:coda@localhost:5432/coda";

// Placeholder Clerk secrets so the auth layer boots deterministically in tests
// without real credentials. Token/webhook verification is mocked at the SDK
// boundary, so these values are never used to reach Clerk.
process.env.CLERK_SECRET_KEY ??= "sk_test_placeholder";
process.env.CLERK_WEBHOOK_SECRET ??= "whsec_placeholder";
