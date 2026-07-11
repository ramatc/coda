import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import { CatalogQueue } from "./catalog-queue.js";
import { SearchQueue } from "../search/search-queue.js";
import { SPOTIFY_PAGE_LIMIT } from "./catalog-import.constants.js";
import type { CatalogCheckpointStore } from "./spotify-checkpoint.store.js";
import type { NormalizedAlbum } from "./spotify.types.js";

export interface ImportPageResult {
  /**
   * How many albums this page FETCHED from Spotify — not how many were
   * upserted or reached {@link enqueueEnrichment} (judgment-day issue #1,
   * round 5): an album skipped at the upsert stage (P2002/P2003/malformed)
   * still counts here even though it never reaches the enqueue attempt.
   */
  processed: number;
  /** Offset of the next page, or `null` when this was the final page. */
  nextOffset: number | null;
  /**
   * How many albums on this page actually reached an `enqueueEnrichment`
   * call attempt (judgment-day issue #1, round 5) — only albums that passed
   * the upsert stage AND had a {@link CatalogQueue} injected. Always `0` when
   * no queue is injected. This is the correct denominator for
   * {@link enqueueFailures}, since {@link processed} also counts albums that
   * were skipped before ever reaching the enqueue attempt.
   */
  enqueueAttempts: number;
  /**
   * How many `enqueueEnrichment` calls failed on this page (judgment-day
   * issue #1, round 3). Always `0` when no {@link CatalogQueue} is injected.
   */
  enqueueFailures: number;
}

export interface RunImportResult {
  /**
   * Total albums FETCHED from Spotify across every page of this run — not
   * how many were upserted or reached {@link enqueueEnrichment} (judgment-day
   * issue #1, round 5); see {@link ImportPageResult.processed}.
   */
  processed: number;
  /** How many pages were fetched. */
  pages: number;
  /**
   * Total albums across every page of this run that actually reached an
   * `enqueueEnrichment` call attempt (judgment-day issue #1, round 5) — the
   * correct denominator for {@link enqueueFailures}. See
   * {@link ImportPageResult.enqueueAttempts}.
   */
  enqueueAttempts: number;
  /**
   * Total `enqueueEnrichment` failures across every page of this run
   * (judgment-day issue #1, round 3) — the aggregate signal an operator needs
   * to detect a total enrichment-queue outage that per-album WARN logs alone
   * would bury. {@link runImport} always reports this count in its summary
   * log, at `logger.warn` whenever it is non-zero (Fase 1 MVP scope: a single
   * operator watches the console output of their own `seed:catalog` run, so a
   * plain elevated-level count is enough signal — no ratio/floor heuristics).
   */
  enqueueFailures: number;
}

export interface RunImportOptions {
  /** Page size (defaults to {@link SPOTIFY_PAGE_LIMIT}). */
  limit?: number;
  /**
   * Force a starting offset instead of resuming from the checkpoint. Used by a
   * full re-seed; omit to resume an interrupted import from its cursor.
   */
  startOffset?: number;
  /** Override the checkpoint store (tests inject an in-memory fake). */
  checkpoint?: CatalogCheckpointStore;
}

/**
 * Core of the Spotify bulk seed (Decisions #4/#5). Owns the two load-bearing,
 * queue-agnostic operations the whole pipeline is built on:
 *
 *  - {@link upsertAlbum}: the idempotent Artist+Album upsert keyed on the unique
 *    `spotifyId` — safe to run any number of times for the same album.
 *  - {@link runImport}: an in-process resumable pager that reads/writes the Redis
 *    checkpoint, used directly by the `seed:catalog` script (simple local/CI
 *    trigger, no separate worker process) and mirrored by the BullMQ page worker
 *    for the distributed path.
 *
 * `queue` is a type-OPTIONAL, injected `CatalogQueue` parameter (judgment-day
 * issue #1): when present, {@link importPage} enqueues a MusicBrainz
 * enrichment job for each album it successfully upserts — the same chaining
 * `catalog-worker.ts`'s album Worker does after its own `upsertAlbum` call —
 * so the CLI `seed:catalog` path enriches too, not just the distributed queue
 * path. The two paths are deliberately NOT identical on an enqueue failure,
 * though (judgment-day issue #1, round 3): {@link importPage} wraps its
 * `enqueueEnrichment` call in a try/catch and logs-and-continues, because a
 * CLI run has no built-in retry once the process exits — propagating would
 * abort the whole run over a transient queue hiccup. `catalog-worker.ts`'s
 * album Worker deliberately leaves the equivalent call UNWRAPPED instead, so
 * a failure fails that BullMQ job and gets BullMQ's own retry/backoff plus
 * failed-job-set visibility rather than a swallowed log line — see the
 * comment at that call site for the full reasoning. `CatalogQueue` is a
 * registered provider in this module with no `@Optional()` decorator, so in
 * production Nest's DI ALWAYS resolves and injects it — there is no
 * supported "enrichment-disabled" deployment mode. The `?` on the
 * constructor parameter exists purely for test-construction convenience: it
 * preserves the resume-without-duplicates guarantee's unit-testability
 * against fakes, without a live Redis, BullMQ, or Postgres (sandbox
 * convention from PR1-3) — tests that don't care about enrichment simply
 * omit it by passing fewer constructor args.
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spotify: SpotifyClient,
    private readonly checkpointStore: SpotifyCheckpointStore,
    private readonly queue?: CatalogQueue,
    // Optional like `queue` (same test-construction convenience): when present,
    // each successfully-upserted album is also chained into a search-sync so the
    // CLI `seed:catalog` path keeps Meilisearch current, not just the queue path.
    private readonly searchQueue?: SearchQueue,
  ) {}

  /**
   * Idempotently upserts an album and its primary artist by their unique
   * `spotifyId`. Re-running with the same album updates the existing rows in
   * place rather than inserting duplicates — the correctness backstop that makes
   * both queue-level dedup and checkpoint resume safe (Decision #5).
   *
   * Runs in a transaction so the artist and album land together: the album's
   * `primaryArtistId` FK always resolves, even if two pages race the same album.
   */
  async upsertAlbum(album: NormalizedAlbum): Promise<void> {
    const { primaryArtist } = album;
    await this.prisma.client.$transaction(async (tx) => {
      const artist = await tx.artist.upsert({
        where: { spotifyId: primaryArtist.spotifyId },
        create: {
          spotifyId: primaryArtist.spotifyId,
          name: primaryArtist.name,
          imageUrl: primaryArtist.imageUrl,
        },
        update: {
          name: primaryArtist.name,
          imageUrl: primaryArtist.imageUrl,
        },
        select: { id: true },
      });

      const releaseDate = album.releaseDate ? new Date(album.releaseDate) : null;
      await tx.album.upsert({
        where: { spotifyId: album.spotifyId },
        create: {
          spotifyId: album.spotifyId,
          title: album.title,
          releaseDate,
          coverUrl: album.coverUrl,
          trackCount: album.trackCount,
          popularityScore: album.popularityScore,
          primaryArtist: { connect: { id: artist.id } },
        },
        update: {
          title: album.title,
          releaseDate,
          coverUrl: album.coverUrl,
          trackCount: album.trackCount,
          popularityScore: album.popularityScore,
          primaryArtist: { connect: { id: artist.id } },
        },
      });
    });
  }

  /**
   * Fetches one Spotify page and upserts every album on it. Returns the next
   * offset (or `null` on the final page) so the caller — the in-process pager or
   * the BullMQ page worker — knows whether to continue.
   *
   * A single malformed record (a Prisma validation error from a bad/missing
   * field shape), a P2002 unique-constraint conflict, or a P2003 foreign-key
   * violation is logged and skipped rather than aborting the rest of the page
   * (judgment-day issue #7) — otherwise, on the CLI `runImport` path, a single
   * poison-pill album would abort the WHOLE run, and since the checkpoint only
   * advances on page completion, it would be retried at the identical offset
   * forever. Any other error (e.g. a lost DB connection) still propagates so
   * it isn't silently swallowed.
   *
   * When {@link queue} is present, each successfully-upserted album is chained
   * into MusicBrainz enrichment (judgment-day issue #1) — only reached when the
   * upsert above succeeded (a skipped album `continue`s past it), so an album
   * that didn't persist never gets enqueued for enrichment. The enqueue call
   * itself is error-isolated too (judgment-day issue #1, round 2): a transient
   * queue-producer failure is logged and skipped rather than propagating and
   * aborting the rest of the run. Each such failure also increments the
   * returned {@link ImportPageResult.enqueueFailures} counter (judgment-day
   * issue #1, round 3) so {@link runImport} can detect a total, run-wide
   * enrichment-enqueue outage that per-album WARN logs alone would bury.
   */
  async importPage(
    offset: number,
    limit: number = SPOTIFY_PAGE_LIMIT,
  ): Promise<ImportPageResult> {
    const page = await this.spotify.getAlbumPage(offset, limit);
    let enqueueAttempts = 0;
    let enqueueFailures = 0;
    for (const album of page.albums) {
      try {
        await this.upsertAlbum(album);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientValidationError) {
          this.logger.warn(
            `Skipping malformed album ${album.spotifyId}: ${err.message}`,
          );
          continue;
        }
        if (isUniqueConstraintViolation(err)) {
          const field = extractUniqueConstraintField(err);
          this.logger.warn(
            `Skipping album ${album.spotifyId} due to a unique constraint ` +
              `conflict${field ? ` on "${field}"` : ""}: ${err.message}`,
          );
          continue;
        }
        if (isForeignKeyViolation(err)) {
          this.logger.warn(
            `Skipping album ${album.spotifyId} due to a foreign key violation: ${err.message}`,
          );
          continue;
        }
        throw err;
      }
      if (this.queue) {
        // Isolated from the upsert's try/catch above (judgment-day issue #1,
        // round 2): a transient Redis/BullMQ producer error here must not
        // propagate uncaught and abort the rest of the run — the album already
        // persisted, so we log-and-continue rather than losing every remaining
        // album/page on a queue hiccup with no retry.
        enqueueAttempts += 1;
        try {
          await this.queue.enqueueEnrichment(album.spotifyId);
        } catch (err) {
          enqueueFailures += 1;
          this.logger.warn(
            `Failed to enqueue enrichment for album ${album.spotifyId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (this.searchQueue) {
        // Best-effort, error-isolated like the enrichment enqueue above: a
        // transient Redis/BullMQ hiccup enqueuing the search-sync must not abort
        // the rest of the CLI run (the album already persisted, and the index
        // can always be rebuilt with `reindex:search`). Kept intentionally
        // simple — no aggregate failure counters here (unlike enrichment, whose
        // counters exist for a specific judgment-day reason): a plain per-album
        // WARN is enough operator signal for the single-operator MVP model.
        try {
          await this.searchQueue.enqueueAlbumSync(album.spotifyId);
        } catch (err) {
          this.logger.warn(
            `Failed to enqueue search-sync for album ${album.spotifyId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return {
      processed: page.albums.length,
      nextOffset: page.nextOffset,
      enqueueAttempts,
      enqueueFailures,
    };
  }

  /**
   * Resumable in-process import. Resolves the starting offset from the Redis
   * checkpoint (unless `startOffset` overrides it), then pages until Spotify
   * reports no more results — writing the checkpoint AFTER each page so a crash
   * mid-run resumes from the last fully processed page, never re-doing completed
   * work and never skipping a page. Clears the checkpoint on clean completion.
   *
   * Fase 1 MVP scope note: this assumes a single operator triggers an import
   * at a time (via this CLI script or the admin endpoint) — there is no
   * distributed lock preventing a concurrent run, and no automatic recovery
   * for a permanently-failed BullMQ job; an operator retries those manually.
   *
   * Aggregates each page's {@link ImportPageResult.enqueueFailures} (against
   * {@link ImportPageResult.enqueueAttempts} — the correct denominator, since
   * `processed` also counts albums that were skipped before ever reaching an
   * enqueue attempt; judgment-day issue #1, round 5) into a run-wide total
   * (judgment-day issue #1, round 3): `importPage`'s per-album try/catch only
   * logs a WARN per failure, which an operator not tailing logs would never
   * see — so this method's final summary always reports the count, at
   * `logger.warn` whenever `enqueueFailures > 0` (and the normal `logger.log`
   * level otherwise). Fase 1 MVP scope note: a single operator manually runs
   * `seed:catalog` and watches its own console output, so an always-present,
   * honest count at an appropriately elevated level is enough — no
   * ratio/floor heuristics about what fraction of failures counts as
   * "enough" to be alarming (simplified from the escalation heuristic added
   * in judgment-day issue #1, rounds 3-5, which over-engineered this for
   * Fase 1's actual usage).
   */
  async runImport(options: RunImportOptions = {}): Promise<RunImportResult> {
    const limit = options.limit ?? SPOTIFY_PAGE_LIMIT;
    const checkpoint = options.checkpoint ?? this.checkpointStore;

    let offset = options.startOffset ?? (await checkpoint.get()) ?? 0;

    let processed = 0;
    let pages = 0;
    let enqueueAttempts = 0;
    let enqueueFailures = 0;
    for (;;) {
      const result = await this.importPage(offset, limit);
      processed += result.processed;
      pages += 1;
      enqueueAttempts += result.enqueueAttempts;
      enqueueFailures += result.enqueueFailures;

      if (result.nextOffset === null) {
        // Import finished cleanly — drop the cursor so the next run starts fresh.
        await checkpoint.clear();
        break;
      }
      // Persist progress BEFORE advancing: if we die now, the resume reads this
      // offset and re-fetches only the not-yet-completed remainder.
      await checkpoint.set(result.nextOffset);
      offset = result.nextOffset;
    }

    const summary =
      `Spotify import complete: ${processed} albums across ${pages} pages, ` +
      `${enqueueFailures} enrichment enqueue failures`;
    // Elevated to WARN whenever there were any enqueue failures — a single,
    // always-present, honest count is enough signal for Fase 1 MVP's actual
    // usage (one operator manually running `seed:catalog` and watching its
    // own console output); no ratio/floor heuristic about what fraction of
    // failures is "enough" to be alarming (simplified from judgment-day
    // issue #1, rounds 3-5).
    if (enqueueFailures > 0) {
      this.logger.warn(summary);
    } else {
      this.logger.log(summary);
    }
    return { processed, pages, enqueueAttempts, enqueueFailures };
  }
}
