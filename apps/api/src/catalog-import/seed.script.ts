import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { CatalogImportService } from "./catalog-import.service.js";
import { SPOTIFY_PAGE_LIMIT } from "./catalog-import.constants.js";

/**
 * Local/CI trigger for the Spotify bulk seed. Run with
 * `pnpm --filter @coda/api seed:catalog`.
 *
 * Unlike the admin HTTP endpoint (which enqueues onto BullMQ for the distributed
 * worker to consume), this drives the import IN-PROCESS via
 * {@link CatalogImportService.runImport}: a trusted local process needs no
 * admin token and no separate worker/queue round-trip. It still shares the exact
 * same fetch + idempotent-upsert + Redis-checkpoint core, so it resumes from an
 * interrupted cursor and never inserts duplicates, identically to the queue path.
 *
 * `SEED_START_OFFSET=0` forces a full re-seed; omit it to resume from the
 * checkpoint.
 */
async function main(): Promise<void> {
  const logger = new Logger("SeedCatalog");
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const service = app.get(CatalogImportService);
    const startEnv = process.env.SEED_START_OFFSET;
    const startOffset =
      startEnv !== undefined ? Number.parseInt(startEnv, 10) : undefined;

    logger.log("Starting Spotify catalog seed...");
    const result = await service.runImport({
      limit: SPOTIFY_PAGE_LIMIT,
      startOffset: Number.isNaN(startOffset as number) ? undefined : startOffset,
    });
    logger.log(
      `Seed finished: ${result.processed} albums across ${result.pages} pages`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[seed:catalog] failed:", err);
  process.exit(1);
});
