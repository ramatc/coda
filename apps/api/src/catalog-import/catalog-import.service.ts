import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import { SPOTIFY_PAGE_LIMIT } from "./catalog-import.constants.js";
import type { CatalogCheckpointStore } from "./spotify-checkpoint.store.js";
import type { NormalizedAlbum } from "./spotify.types.js";

/** Prisma error code for a foreign-key constraint violation. */
const FOREIGN_KEY_VIOLATION = "P2003";

/**
 * Sentinel token returned by {@link CatalogImportService.tryAcquireRunningLock}
 * when the given checkpoint doesn't implement the running-lock guard at all
 * (in-memory test fakes — see {@link CatalogCheckpointStore}'s optional
 * methods). Any non-null string works as a "no real lock" placeholder here
 * since {@link CatalogImportService.releaseRunningLock} only forwards it when
 * the checkpoint actually supports `releaseRunningLock`.
 */
const NO_LOCK_SUPPORT_TOKEN = "no-lock-support";

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
 * Keeping this class free of any BullMQ dependency is deliberate: it makes the
 * resume-without-duplicates guarantee unit-testable against fakes, without a
 * live Redis or Postgres (sandbox convention from PR1-3).
 */
@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spotify: SpotifyClient,
    private readonly checkpointStore: SpotifyCheckpointStore,
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
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === FOREIGN_KEY_VIOLATION
        ) {
          this.logger.warn(
            `Skipping album ${album.spotifyId} due to a foreign key violation: ${err.message}`,
          );
          continue;
        }
        throw err;
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
   * Guarded by the shared running-lock marker (judgment-day issue #6) so this
   * in-process pager (`seed:catalog`) can't race the BullMQ page-worker
   * pipeline over the same checkpoint; see
   * {@link CatalogCheckpointStore.tryAcquireRunningLock} for why this is a
   * best-effort marker rather than a full renewing distributed lock.
   */
  async runImport(options: RunImportOptions = {}): Promise<RunImportResult> {
    const limit = options.limit ?? SPOTIFY_PAGE_LIMIT;
    const checkpoint = options.checkpoint ?? this.checkpointStore;

    const lockToken = await this.tryAcquireRunningLock(checkpoint);
    if (!lockToken) {
      throw new Error(
        "Catalog import is already in progress — refusing to start a concurrent run.",
      );
    }

    try {
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
    } finally {
      await this.releaseRunningLock(checkpoint, lockToken);
    }
  }

  /**
   * Acquires the shared running-lock marker if the given checkpoint store
   * supports it (real {@link SpotifyCheckpointStore} instances do; in-memory
   * test fakes may omit it since single-run unit tests never race two
   * imports — see the optional methods on {@link CatalogCheckpointStore}).
   * Returns the ownership token to thread through to {@link releaseRunningLock}
   * (judgment-day issue #2), or {@link NO_LOCK_SUPPORT_TOKEN} when the
   * checkpoint doesn't implement the guard at all.
   */
  private async tryAcquireRunningLock(
    checkpoint: CatalogCheckpointStore,
  ): Promise<string | null> {
    if (typeof checkpoint.tryAcquireRunningLock !== "function") {
      return NO_LOCK_SUPPORT_TOKEN;
    }
    return checkpoint.tryAcquireRunningLock();
  }

  /**
   * Releases the marker acquired by {@link tryAcquireRunningLock}, if
   * supported, passing back the SAME ownership token so the store only
   * releases the lock this run actually holds (judgment-day issue #2).
   */
  private async releaseRunningLock(
    checkpoint: CatalogCheckpointStore,
    token: string,
  ): Promise<void> {
    if (typeof checkpoint.releaseRunningLock === "function") {
      await checkpoint.releaseRunningLock(token);
    }
  }
}
