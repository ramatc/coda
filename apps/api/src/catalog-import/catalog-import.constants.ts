/**
 * Catalog-import (Spotify bulk seed) constants: queue names, the Redis
 * pagination-checkpoint key, page sizing, and the deterministic job-id helpers.
 *
 * The bulk seed (design Decisions #4/#5) fans out over BullMQ: a producer
 * enqueues page jobs, a page worker fetches each Spotify page and fans out one
 * per-album job per album, and an album worker performs the idempotent upsert.
 * Two invariants make the whole thing safe to interrupt and re-run:
 *
 *  1. Per-album jobs use a DETERMINISTIC job id (`album:{spotifyId}`), so
 *     BullMQ dedupes at the queue level — the same album surfacing again (on a
 *     resume, or across overlapping pages) never enqueues a duplicate job.
 *  2. A Redis pagination checkpoint records the last completed page offset, so
 *     an import killed mid-run resumes from where it stopped instead of
 *     restarting from zero.
 *
 * The upsert itself is keyed on the unique `spotifyId` column, so even if a job
 * DID run twice it would update-in-place rather than insert a duplicate row.
 */

import type { JobsOptions } from "bullmq";

/** Env var: Spotify app client id (client-credentials OAuth). */
export const SPOTIFY_CLIENT_ID_ENV = "SPOTIFY_CLIENT_ID";
/** Env var: Spotify app client secret (client-credentials OAuth). */
export const SPOTIFY_CLIENT_SECRET_ENV = "SPOTIFY_CLIENT_SECRET";
/** Env var: Redis connection URL (shared with Fase 0; also used by BullMQ). */
export const REDIS_URL_ENV = "REDIS_URL";
/**
 * Env var: comma-separated allowlist of Clerk user ids permitted to trigger a
 * bulk import via the admin endpoint. Unset ⇒ the endpoint fails CLOSED (denies
 * everyone) — an unconfigured admin surface must never be world-open, since a
 * bulk import is an expensive, abusable operation (see {@link CatalogAdminGuard}).
 */
export const CATALOG_ADMIN_USER_IDS_ENV = "CATALOG_ADMIN_USER_IDS";

/** Default Redis URL when `REDIS_URL` is unset (matches docker-compose/Fase 0). */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** BullMQ queue holding page jobs (fetch one Spotify page + fan out albums). */
export const CATALOG_PAGE_QUEUE = "catalog-spotify-page";
/** BullMQ queue holding per-album jobs (idempotent upsert of Artist+Album). */
export const CATALOG_ALBUM_QUEUE = "catalog-spotify-album";

/** BullMQ job name for a page job. */
export const PAGE_JOB_NAME = "spotify-page";
/** BullMQ job name for a per-album job. */
export const ALBUM_JOB_NAME = "spotify-album";

/** Redis key storing the last completed page offset (the resume cursor). */
export const CHECKPOINT_KEY = "catalog-import:spotify:offset";

/**
 * Redis key marking "an import is currently running" (judgment-day issue #6):
 * a best-effort mutual-exclusion marker shared by the in-process `seed:catalog`
 * pager and the BullMQ page-worker pipeline, both of which read/write
 * {@link CHECKPOINT_KEY} with no other coordination.
 */
export const CHECKPOINT_RUNNING_LOCK_KEY = "catalog-import:spotify:running-lock";

/**
 * TTL for {@link CHECKPOINT_RUNNING_LOCK_KEY}. This is a best-effort guard, not
 * a renewed/heartbeat lock: a run that's still legitimately in progress past
 * this window would let a second run start, and a crashed run's marker
 * self-expires after this window rather than blocking forever. A full
 * renewing distributed lock was judged disproportionate to this PR's scope —
 * see the comment on `CatalogImportService.runImport`.
 */
export const CHECKPOINT_RUNNING_LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Albums fetched per Spotify page. Spotify's browse/search endpoints cap `limit`
 * at 50, so this is both the page size and the API max.
 */
export const SPOTIFY_PAGE_LIMIT = 50;

/**
 * Spotify's documented hard cap on `/v1/search`'s `offset` + `limit`: once
 * pagination would cross this cap, Spotify returns a non-OK response
 * regardless of `total` (see {@link SpotifyClient.getAlbumPage}). This bounds
 * the practical per-query import size to ~1000 results — reaching the ~100k
 * album goal requires partitioning the catalog across multiple distinct seed
 * queries, which is out of scope for this PR (see the doc-note on the pager).
 */
export const SPOTIFY_SEARCH_MAX_OFFSET = 1000;

/**
 * Shared BullMQ retry/cleanup policy for both page and per-album jobs.
 * Without `attempts`/`backoff`, BullMQ defaults to `attempts: 1` — any
 * transient failure (Spotify 429/5xx, a DB hiccup, a malformed record)
 * permanently drops that job, and because job ids are deterministic, a failed
 * job also silently blocks any future re-enqueue attempt with the same id
 * (BullMQ treats adding a job with an already-used id as a no-op). Bounded
 * `removeOnComplete`/`removeOnFail` keeps Redis from growing unbounded while
 * still leaving a retries-exhausted failed job inspectable/re-triggerable
 * instead of vanishing (`removeOnFail: true` would delete it outright and
 * defeat this fix).
 */
export const CATALOG_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

/**
 * Deterministic per-album job id (`album:{spotifyId}`). Passing this as BullMQ's
 * `jobId` makes re-enqueuing the same album a no-op at the queue level — the
 * natural-dedup guarantee the resume path relies on.
 */
export function albumJobId(spotifyId: string): string {
  return `album:${spotifyId}`;
}

/**
 * Deterministic page job id (`spotify-page:{offset}`). Keeps a given page from
 * being enqueued twice when a resume re-derives the same offset.
 */
export function pageJobId(offset: number): string {
  return `${PAGE_JOB_NAME}:${offset}`;
}
