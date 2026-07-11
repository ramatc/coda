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
 * `CatalogImportService` is resolved from the same `AppModule` DI container the
 * admin/worker path uses, so its optional `CatalogQueue` dependency is injected
 * here too — each successfully-upserted album is chained into MusicBrainz
 * enrichment exactly as `catalog-worker.ts`'s album Worker does, so this CLI
 * path enriches, not just upserts (judgment-day issue #1; a standalone
 * `worker:catalog` process with its enrich Worker running must still be up to
 * actually process the enqueued enrichment jobs — this script only enqueues).
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
    // `result.enqueueFailures` (judgment-day issue #1, round 3): surfaced here
    // too so this CLI's own summary line — not just `runImport`'s internal
    // log — shows whether enrichment enqueueing actually worked. `runImport`
    // already logs its own summary at `logger.warn` whenever there were any
    // enqueue failures (simplified from the earlier escalation heuristic).
    logger.log(
      `Seed finished: ${result.processed} albums across ${result.pages} pages` +
        (result.enqueueFailures > 0
          ? ` (${result.enqueueFailures} enrichment enqueue failures)`
          : ""),
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error("[seed:catalog] failed:", err);
  process.exit(1);
});
