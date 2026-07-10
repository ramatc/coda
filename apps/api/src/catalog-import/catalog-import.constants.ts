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

/**
 * Env var: descriptive User-Agent string identifying this application to
 * MusicBrainz. MusicBrainz's usage policy REQUIRES a meaningful, contactable
 * User-Agent (app name/version + contact URL or email), e.g.
 * `Coda/1.0 (https://coda.example.com)`. Requests without one are throttled or
 * blocked. Unset means the {@link MusicBrainzClient} fails fast (see its
 * `requireConfig`).
 */
export const MUSICBRAINZ_USER_AGENT_ENV = "MUSICBRAINZ_USER_AGENT";
/**
 * Env var: optional MusicBrainz API base URL override (e.g. a self-hosted mirror
 * or a staging proxy). Defaults to the real `https://musicbrainz.org` host, so
 * no extra config is required in production.
 */
export const MUSICBRAINZ_BASE_URL_ENV = "MUSICBRAINZ_BASE_URL";

/** Default Redis URL when `REDIS_URL` is unset (matches docker-compose/Fase 0). */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** BullMQ queue holding page jobs (fetch one Spotify page + fan out albums). */
export const CATALOG_PAGE_QUEUE = "catalog-spotify-page";
/** BullMQ queue holding per-album jobs (idempotent upsert of Artist+Album). */
export const CATALOG_ALBUM_QUEUE = "catalog-spotify-album";
/**
 * BullMQ queue holding per-album MusicBrainz enrichment jobs (PR6). Chained off
 * the per-album upsert: once the Spotify album worker persists an album, it
 * enqueues one enrich job here to fetch its MusicBrainz mbid + genres. This
 * queue's Worker carries the {@link MUSICBRAINZ_RATE_LIMIT} limiter so the whole
 * fleet never exceeds MusicBrainz's ≤1 req/s policy.
 */
export const CATALOG_ENRICH_QUEUE = "catalog-musicbrainz-enrich";

/** BullMQ job name for a page job. */
export const PAGE_JOB_NAME = "spotify-page";
/** BullMQ job name for a per-album job. */
export const ALBUM_JOB_NAME = "spotify-album";
/** BullMQ job name for a per-album MusicBrainz enrichment job. */
export const ENRICH_JOB_NAME = "musicbrainz-enrich";

/** Redis key storing the last completed page offset (the resume cursor). */
export const CHECKPOINT_KEY = "catalog-import:spotify:offset";

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
 * Minimum spacing between consecutive MusicBrainz HTTP requests, in
 * milliseconds. MusicBrainz's usage policy caps anonymous/app clients at ≤1
 * request/second; 1100ms (not a flat 1000ms) leaves a safety margin so clock
 * jitter or a slightly-late timer can never straddle the boundary and let two
 * requests land inside the same 1s window. {@link MusicBrainzClient} enforces
 * this CLIENT-side (a serialized min-interval gate) as defense-in-depth on top
 * of the queue-level {@link MUSICBRAINZ_RATE_LIMIT}.
 */
export const MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS = 1100;

/**
 * BullMQ Worker rate-limiter for the MusicBrainz enrichment queue (design
 * Decision #4): at most ONE job processed per {@link MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS}
 * across the whole worker fleet, so scaling out enrich workers never breaches
 * MusicBrainz's ≤1 req/s policy. This is the queue-level guard; the client-side
 * gate is the second layer that also covers non-worker callers.
 */
export const MUSICBRAINZ_RATE_LIMIT = {
  max: 1,
  duration: MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
} as const;

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
 * BullMQ retry/cleanup policy for the MusicBrainz enrichment queue specifically
 * (judgment-day issue #4, Round 4+). Reusing {@link CATALOG_JOB_OPTIONS} verbatim
 * under-retains completed jobs for this queue: page/album jobs are cheap and
 * plentiful, but each enrich job costs a scarce, rate-limited MusicBrainz call
 * (≤1 req/s), so there are comparatively far fewer of them and each is far more
 * expensive to redo. A much larger `removeOnComplete` keeps the deterministic
 * `mbenrich:{spotifyId}` job id dedupe-able for a realistic ~100k-album seed run
 * instead of aging out after only 1000 completions and silently reopening the
 * door to a wasted re-lookup. `attempts`/`backoff`/`removeOnFail` stay identical
 * to {@link CATALOG_JOB_OPTIONS} — only the completed-job retention widens.
 */
export const CATALOG_ENRICH_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 50000 },
  removeOnFail: { count: 5000 },
};

/**
 * Env var: optional override for {@link MIN_SAMPLE_FOR_ESCALATION} (judgment-day
 * issue #1, round 5). A resumed run's tail page (or any deliberately small
 * run) may never reach the default floor below, so a genuine total outage
 * confined to that tail would never escalate. Unset, missing, or non-numeric
 * falls back to the default.
 */
export const CATALOG_ENRICH_MIN_SAMPLE_FOR_ESCALATION_ENV =
  "CATALOG_ENRICH_MIN_SAMPLE_FOR_ESCALATION";

/** Default {@link MIN_SAMPLE_FOR_ESCALATION} when the env override is unset. */
const DEFAULT_MIN_SAMPLE_FOR_ESCALATION = 10;

function resolveMinSampleForEscalation(): number {
  const raw = process.env[CATALOG_ENRICH_MIN_SAMPLE_FOR_ESCALATION_ENV];
  if (raw === undefined) {
    return DEFAULT_MIN_SAMPLE_FOR_ESCALATION;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_MIN_SAMPLE_FOR_ESCALATION : parsed;
}

/**
 * Minimum `enqueueAttempts` count {@link CatalogImportService.runImport}
 * requires before a near-total-`enqueueFailures` run escalates to
 * `logger.error` (judgment-day issue #1, round 4; overridable via
 * {@link CATALOG_ENRICH_MIN_SAMPLE_FOR_ESCALATION_ENV}, round 5). Without a
 * floor, "1 failure out of 1 attempt" satisfies the same near-100% condition
 * as "500 failures out of 500 attempts" — a single transient blip on a small
 * run (a short/dev-catalog run, a resumed run's tail page, or simply the last
 * page of any import) would trip the same escalation as a genuine full-run
 * outage. Below this threshold, the existing per-album `logger.warn` calls
 * are already sufficient signal; only a near-total failure across at least
 * this many enqueue attempts escalates.
 */
export const MIN_SAMPLE_FOR_ESCALATION = resolveMinSampleForEscalation();

/**
 * Minimum enqueue-failure ratio (judgment-day issue #1, round 5) at/above
 * which {@link CatalogImportService.runImport} escalates to `logger.error`.
 * Strict equality to 100% previously meant a near-total outage — e.g.
 * 9999 failures out of 10000 attempts — never escalated. 0.95 (95%+) catches
 * that case while still requiring an overwhelming majority of enqueue
 * attempts to have failed, not just a handful of unlucky ones.
 */
export const ENQUEUE_FAILURE_ESCALATION_RATIO = 0.95;

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

/**
 * Deterministic MusicBrainz-enrichment job id (`mbenrich:{spotifyId}`). Keys the
 * enrich job to the album's stable Spotify id so re-enqueuing the same album
 * (on a resume, or an overlapping page) is a queue-level no-op — the same
 * natural-dedup guarantee the Spotify album jobs rely on.
 */
export function enrichJobId(spotifyId: string): string {
  return `mbenrich:${spotifyId}`;
}
