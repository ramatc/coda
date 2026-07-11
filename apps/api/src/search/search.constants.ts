/**
 * Search (Meilisearch) constants: env var names, index identifiers, the
 * write-through `search-sync` BullMQ queue, and pagination bounds.
 *
 * Search is a rebuildable read projection over Postgres (design Decision #6):
 * the catalog-import pipeline write-throughs album/artist documents into
 * Meilisearch via the `search-sync` queue as it upserts rows, and the whole
 * index can be rebuilt from scratch from Postgres with the `reindex:search`
 * script. Postgres stays the source of truth; Meili is derived and disposable.
 */

import type { JobsOptions } from "bullmq";

/**
 * Env var: base URL of the Meilisearch instance (e.g. `http://localhost:7700`).
 * Defaults to {@link DEFAULT_MEILI_HOST} when unset so local dev and the unit
 * suite (which stubs `fetch` anyway) both work without extra config.
 */
export const MEILI_HOST_ENV = "MEILI_HOST";
/**
 * Env var: Meilisearch master (or API) key sent as a Bearer token. Optional in a
 * keyless local dev instance; REQUIRED against any production Meili, which
 * refuses unauthenticated writes. Unset ⇒ requests are sent without an
 * `Authorization` header.
 */
export const MEILI_MASTER_KEY_ENV = "MEILI_MASTER_KEY";

/** Default Meilisearch host when {@link MEILI_HOST_ENV} is unset. */
export const DEFAULT_MEILI_HOST = "http://localhost:7700";

/** Meilisearch index holding album documents (pk `id` = local `Album.id`). */
export const ALBUMS_INDEX = "albums";
/** Meilisearch index holding artist documents (pk `id` = local `Artist.id`). */
export const ARTISTS_INDEX = "artists";

/**
 * Index settings applied by {@link MeiliService.configureIndexes} (design
 * Decision #6). Idempotent — re-applying the same settings is a no-op on
 * Meili's side, so this is safe to run on every worker boot and every reindex.
 */
export const ALBUMS_INDEX_SETTINGS = {
  searchableAttributes: ["title", "primaryArtistName", "genreNames"],
  filterableAttributes: ["genreSlugs", "releaseYear"],
  sortableAttributes: ["popularityScore"],
} as const;

/**
 * Artist index settings. The Fase-1 `Artist` model has no popularity column, so
 * there is no `sortableAttributes` popularity field here (a documented deviation
 * from the design's "sortable popularity" note) — artist results rank on
 * Meili's default relevance, which is sufficient for name lookup.
 */
export const ARTISTS_INDEX_SETTINGS = {
  searchableAttributes: ["name"],
  filterableAttributes: [],
  sortableAttributes: [],
} as const;

/**
 * BullMQ queue holding per-album search-sync jobs (design Decision #6). The
 * catalog album worker enqueues one of these after each successful upsert, so a
 * freshly-imported album becomes searchable without waiting on the rate-limited
 * MusicBrainz enrichment leg. Decoupling the Meili write behind a queue also
 * means a transient Meili outage is absorbed by BullMQ retry/backoff rather than
 * failing the catalog import.
 */
export const SEARCH_SYNC_QUEUE = "search-sync";
/** BullMQ job name for a per-album search-sync job. */
export const SEARCH_SYNC_JOB_NAME = "search-sync-album";

/**
 * Deterministic per-album search-sync job id (`search-album:{spotifyId}`). Keys
 * the sync to the album's stable Spotify id so re-enqueuing the same album (a
 * resume, or an overlapping page) is a queue-level no-op — the same
 * natural-dedup guarantee the Spotify album/enrich jobs rely on.
 */
export function searchAlbumSyncJobId(spotifyId: string): string {
  return `search-album:${spotifyId}`;
}

/**
 * BullMQ retry/cleanup policy for the search-sync queue. Same shape as the
 * catalog page/album policy: without `attempts`/`backoff` a transient Meili
 * hiccup would permanently drop the sync (and, with deterministic job ids,
 * silently block any re-enqueue). Bounded `removeOnComplete`/`removeOnFail`
 * keeps Redis from growing unbounded while leaving a retries-exhausted job
 * inspectable/retriable for an operator (Fase 1 MVP single-operator model).
 */
export const SEARCH_SYNC_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/** Default page size for `GET /search` when the client omits `limit`. */
export const DEFAULT_SEARCH_PAGE_SIZE = 20;
/** Hard cap on `GET /search` page size (clamped, never rejected). */
export const MAX_SEARCH_PAGE_SIZE = 50;
/** Default number of "popular" albums returned for the discover landing view. */
export const DEFAULT_POPULAR_LIMIT = 24;

/**
 * How many rows the `reindex:search` batch pager reads (and pushes to Meili) per
 * round. Bounds memory during a full rebuild of a ~100k-album catalog.
 */
export const REINDEX_BATCH_SIZE = 500;
