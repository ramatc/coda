import { config } from "dotenv";

/**
 * Must be the FIRST import in every entrypoint (main.ts, seed/worker scripts)
 * — before `AppModule` or anything that transitively imports `@coda/db`.
 *
 * `@coda/db`'s client singleton reads `process.env.DATABASE_URL` eagerly at
 * module-import time (see `packages/db/src/client.ts`). Under ESM, an
 * entrypoint's static imports are fully evaluated (recursively) before its
 * own top-level code runs — so by the time `AppModule`'s `ConfigModule.forRoot()`
 * call would populate `process.env` from the repo-root `.env`, `@coda/db` has
 * already been imported and already constructed its Postgres connection with
 * an undefined `DATABASE_URL`. Loading the same root `.env` here, first,
 * closes that gap.
 */
config({ path: "../../.env" });
