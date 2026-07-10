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
import { SPOTIFY_PAGE_LIMIT } from "./catalog-import.constants.js";
import type { CatalogCheckpointStore } from "./spotify-checkpoint.store.js";
import type { NormalizedAlbum } from "./spotify.types.js";

export interface ImportPageResult {
  /** How many albums this page upserted. */
  processed: number;
  /** Offset of the next page, or `null` when this was the final page. */
  nextOffset: number | null;
}

export interface RunImportResult {
  /** Total albums upserted across every page of this run. */
  processed: number;
  /** How many pages were fetched. */
  pages: number;
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
 * enrichment job for each album it successfully upserts — mirroring exactly
 * what `catalog-worker.ts`'s album Worker already does after its own
 * `upsertAlbum` call — so the CLI `seed:catalog` path enriches too, not just
 * the distributed queue path. `CatalogQueue` is a registered provider in this
 * module with no `@Optional()` decorator, so in production Nest's DI ALWAYS
 * resolves and injects it — there is no supported "enrichment-disabled"
 * deployment mode. The `?` on the constructor parameter exists purely for
 * test-construction convenience: it preserves the resume-without-duplicates
 * guarantee's unit-testability against fakes, without a live Redis, BullMQ,
 * or Postgres (sandbox convention from PR1-3) — tests that don't care about
 * enrichment simply omit it by passing fewer constructor args.
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spotify: SpotifyClient,
    private readonly checkpointStore: SpotifyCheckpointStore,
    private readonly queue?: CatalogQueue,
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
   * aborting the rest of the run.
   */
  async importPage(
    offset: number,
    limit: number = SPOTIFY_PAGE_LIMIT,
  ): Promise<ImportPageResult> {
    const page = await this.spotify.getAlbumPage(offset, limit);
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
        try {
          await this.queue.enqueueEnrichment(album.spotifyId);
        } catch (err) {
          this.logger.warn(
            `Failed to enqueue enrichment for album ${album.spotifyId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { processed: page.albums.length, nextOffset: page.nextOffset };
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
   */
  async runImport(options: RunImportOptions = {}): Promise<RunImportResult> {
    const limit = options.limit ?? SPOTIFY_PAGE_LIMIT;
    const checkpoint = options.checkpoint ?? this.checkpointStore;

    let offset = options.startOffset ?? (await checkpoint.get()) ?? 0;

    let processed = 0;
    let pages = 0;
    for (;;) {
      const result = await this.importPage(offset, limit);
      processed += result.processed;
      pages += 1;

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

    this.logger.log(
      `Spotify import complete: ${processed} albums across ${pages} pages`,
    );
    return { processed, pages };
  }
}
