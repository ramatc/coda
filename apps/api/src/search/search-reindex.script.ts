import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { SearchSyncService } from "./search-sync.service.js";

/**
 * Rebuilds the Meilisearch index from Postgres from scratch. Run with
 * `pnpm --filter @coda/api reindex:search`.
 *
 * This is the authoritative "batch sync" path (design Decision #6): it
 * (re)configures the index settings, clears stale documents, and re-projects
 * every album + artist. Use it after a bulk seed, after a schema/settings
 * change, or any time Meilisearch's (disposable) data needs rebuilding — the
 * incremental `search-sync` queue keeps the index current during normal
 * catalog writes, and this restores it wholesale when needed.
 */
async function main(): Promise<void> {
  const logger = new Logger("ReindexSearch");
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    logger.log("Rebuilding the Meilisearch index from Postgres...");
    const result = await app.get(SearchSyncService).reindexAll();
    logger.log(
      `Reindex finished: ${result.albums} album(s), ${result.artists} artist(s)`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error("[reindex:search] failed:", err);
  process.exit(1);
});
