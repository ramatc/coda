import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller.js";
import { SearchService } from "./search.service.js";
import { SearchSyncService } from "./search-sync.service.js";
import { SearchQueue } from "./search-queue.js";
import { MeiliService } from "./meili.service.js";

/**
 * Search module (PR7, design Decision #6). Wires the Meilisearch client, the
 * queue-agnostic sync core, the read-side query service + `GET /search`
 * endpoints, and the BullMQ `search-sync` producer.
 *
 * Like the catalog-import module, NO BullMQ Worker is registered here: the API
 * process only PRODUCES search-sync jobs. The `search-sync` Worker runs in the
 * standalone `catalog-worker.ts` process (design co-locates it with the catalog
 * workers). All infra connections (Redis, Meilisearch) are opened lazily, so
 * importing this module into `AppModule` never touches Redis or Meili at boot.
 *
 * `SearchSyncService`, `SearchQueue`, and `MeiliService` are exported so the
 * catalog worker/CLI can enqueue syncs and the worker/reindex script can run
 * them.
 */
@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    SearchSyncService,
    SearchQueue,
    MeiliService,
  ],
  exports: [SearchSyncService, SearchQueue, MeiliService],
})
export class SearchModule {}
