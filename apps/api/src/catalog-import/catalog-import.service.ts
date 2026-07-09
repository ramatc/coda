import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
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
   */
  async importPage(
    offset: number,
    limit: number = SPOTIFY_PAGE_LIMIT,
  ): Promise<ImportPageResult> {
    const page = await this.spotify.getAlbumPage(offset, limit);
    for (const album of page.albums) {
      await this.upsertAlbum(album);
    }
    return { processed: page.albums.length, nextOffset: page.nextOffset };
  }

  /**
   * Resumable in-process import. Resolves the starting offset from the Redis
   * checkpoint (unless `startOffset` overrides it), then pages until Spotify
   * reports no more results — writing the checkpoint AFTER each page so a crash
   * mid-run resumes from the last fully processed page, never re-doing completed
   * work and never skipping a page. Clears the checkpoint on clean completion.
   */
  async runImport(options: RunImportOptions = {}): Promise<RunImportResult> {
    const limit = options.limit ?? SPOTIFY_PAGE_LIMIT;
    const checkpoint = options.checkpoint ?? this.checkpointStore;
    let offset =
      options.startOffset ?? (await checkpoint.get()) ?? 0;

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
