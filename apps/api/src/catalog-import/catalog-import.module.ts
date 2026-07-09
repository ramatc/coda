import { Module } from "@nestjs/common";
import { CatalogImportController } from "./catalog-import.controller.js";
import { CatalogImportService } from "./catalog-import.service.js";
import { CatalogQueue } from "./catalog-queue.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";

/**
 * Catalog-import module (PR5): Spotify bulk seed. Wires the admin trigger
 * endpoint plus the queue-agnostic core (client, checkpoint store, import
 * service) and the BullMQ producer.
 *
 * No BullMQ Worker is registered here: the API process only PRODUCES jobs. The
 * page/album workers run in the standalone `catalog-worker.ts` process, and all
 * infra connections (Redis, BullMQ queues) are opened lazily, so importing this
 * module into `AppModule` never touches Redis at boot. `PrismaService` and
 * `ConfigService` come from their global modules.
 */
@Module({
  controllers: [CatalogImportController],
  providers: [
    CatalogImportService,
    CatalogQueue,
    SpotifyClient,
    SpotifyCheckpointStore,
  ],
  exports: [CatalogImportService, CatalogQueue],
})
export class CatalogImportModule {}
