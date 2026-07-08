import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env and no longer accepts `url` in the schema
// datasource. Connection config lives here instead. Node 20.12+/22+ can load a
// local .env without a dotenv dependency; missing .env is fine for commands
// that do not need a connection (e.g. `prisma validate`) or for CI, which
// injects env vars directly.
//
// The single source of truth for env vars is the repo-root .env (see
// .env.example). Resolve it from this file's location so the migrate scripts
// work no matter which directory the CLI is invoked from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
for (const candidate of [
  path.join(repoRoot, ".env"),
  path.join(process.cwd(), ".env"),
]) {
  try {
    process.loadEnvFile(candidate);
  } catch {
    // Candidate .env not present — fall through to the ambient environment.
  }
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
