/**
 * Recommendations v1 constants (PR11): the heuristic scoring weights, taste and
 * candidate bounds, the `reco-generation` BullMQ queue identifiers, and the UUID
 * shape guard.
 *
 * Reco v1 is a PRECOMPUTED heuristic (design Decision #7): a BullMQ worker scores
 * catalog albums against a user's onboarding preferences + tracked taste and
 * upserts the top {@link MAX_ACTIVE_RECOMMENDATIONS} into the `Recommendation`
 * table as `ACTIVE`. It deliberately uses ONLY genre/artist overlap + popularity
 * — no embeddings, no pgvector, no collaborative filtering (spec: "No
 * Embedding-Based Scoring"). Postgres stays the source of truth; the
 * `Recommendation` rows are a rebuildable projection.
 */

import type { JobsOptions } from "bullmq";

/** Env var: Redis connection URL (shared with Fase 0; also used by BullMQ). */
export const REDIS_URL_ENV = "REDIS_URL";

/**
 * Heuristic score weights (design "Recommendations v1 algorithm"):
 * `score = 0.5*genreOverlap + 0.35*artistOverlap + 0.15*log-normPopularity`.
 * Seed values — tuned during beta (design Open Question). They sum to 1 so a
 * perfect-overlap, most-popular album scores 1.0.
 */
export const GENRE_WEIGHT = 0.5;
export const ARTIST_WEIGHT = 0.35;
export const POPULARITY_WEIGHT = 0.15;

/**
 * A rating at or above this score feeds the user's taste profile (its album's
 * genres/artist boost the affinity used to score candidates). Below it, a rating
 * still EXCLUDES the album from being recommended back (the user already tracked
 * it) but does not signal positive taste.
 */
export const HIGH_RATING_THRESHOLD = 7;

/**
 * Extra genre weight contributed by an album the user favorited or rated highly,
 * relative to an explicit onboarding genre preference (weight 1). Kept below 1 so
 * onboarding preferences remain the dominant taste signal for a cold-start user,
 * while tracked activity nudges rather than overrides it.
 */
export const TASTE_ALBUM_GENRE_WEIGHT = 0.5;

/**
 * How many of the user's strongest genres seed the candidate SQL prefilter. A
 * handful is enough to pull a few hundred on-taste candidates without scanning
 * the whole ~100k catalog (design "SQL-prefiltered by joining AlbumGenre on the
 * user's top genres").
 */
export const TOP_GENRES_FOR_PREFILTER = 5;

/**
 * Upper bound on candidate albums pulled (popularity-ordered) from the genre
 * prefilter before app-side scoring. Bounds per-run memory/CPU; the top
 * {@link MAX_ACTIVE_RECOMMENDATIONS} of these become the user's recommendations.
 */
export const CANDIDATE_LIMIT = 300;

/** How many `ACTIVE` recommendations a generation run keeps per user (~top 50). */
export const MAX_ACTIVE_RECOMMENDATIONS = 50;

/** BullMQ queue holding per-user recommendation-generation jobs (Decision #7). */
export const RECO_GENERATION_QUEUE = "reco-generation";
/** BullMQ job name for a per-user generation job. */
export const RECO_GENERATION_JOB_NAME = "reco-generate";
/** BullMQ job name for the nightly full refresh (repeatable). */
export const RECO_NIGHTLY_JOB_NAME = "reco-nightly";

/**
 * Debounce window (ms) for the tracking-triggered regeneration. A burst of
 * tracking writes for one user coalesces into a single delayed generation job
 * (BullMQ no-ops an `add` for a job id already waiting/delayed), so rapid
 * listen/rate/review activity does not enqueue N regenerations — the queue-level
 * dedup IS the debounce, no bespoke counter needed.
 */
export const RECO_DEBOUNCE_MS = 5 * 60 * 1000;

/** Cron for the nightly repeatable full refresh (03:00 daily). */
export const RECO_NIGHTLY_CRON = "0 3 * * *";

/**
 * Deterministic per-user generation job id (`reco-gen:{userId}`). Passing this as
 * BullMQ's `jobId` coalesces overlapping enqueues for the same user (the
 * onboarding-completion trigger and a debounced tracking trigger landing close
 * together) into a single job — generation is an idempotent upsert, so a
 * coalesced or duplicated run is harmless, just wasteful to run twice.
 */
export function recoGenerationJobId(userId: string): string {
  return `reco-gen:${userId}`;
}

/**
 * BullMQ retry/cleanup policy for generation jobs. `removeOnComplete: true` (not
 * a retained count like the catalog queues): generation is a debounced,
 * re-runnable upsert, so a completed job carries no value to inspect and MUST NOT
 * linger — a lingering completed job with the deterministic id would make BullMQ
 * no-op the NEXT debounced/nightly enqueue for that user (it treats an existing
 * id in any state as a duplicate). Removing on completion keeps re-triggering
 * reliable. Bounded `removeOnFail` still leaves a genuinely failed run visible.
 */
export const RECO_GENERATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
};

/**
 * UUID shape guard applied to the `:id` path param of the dismiss endpoint BEFORE
 * it reaches Postgres, so a malformed id surfaces as a clean 400 instead of a raw
 * "invalid input syntax for type uuid" 500 — the same guard rationale as the
 * tracking/activity modules' `UUID_PATTERN`. Kept module-local so the feature
 * modules stay decoupled (a repeated project convention).
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
