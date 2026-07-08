// Load the metadata polyfill before any NestJS decorated class evaluates.
import "reflect-metadata";

// The health check never queries the database, but importing `@coda/db`
// constructs a (lazy, unconnected) Prisma client. Provide a placeholder
// connection string so construction is deterministic in CI without a live DB.
process.env.DATABASE_URL ??= "postgresql://coda:coda@localhost:5432/coda";
