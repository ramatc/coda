import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { MeiliService } from "./meili.service.js";
import { REINDEX_BATCH_SIZE } from "./search.constants.js";
import {
  toAlbumDocument,
  toArtistDocument,
  type AlbumRow,
  type ArtistRow,
} from "./search-document.js";

/** Outcome of a single album's search-sync attempt. */
export type SyncAlbumResult = { status: "synced" } | { status: "album-missing" };

/** Counts produced by a full reindex run. */
export interface ReindexResult {
  albums: number;
  artists: number;
}

/** The Prisma `select` shape for an indexable artist (matches {@link ArtistRow}). */
const ARTIST_SELECT = {
  id: true,
  spotifyId: true,
  mbid: true,
  name: true,
  imageUrl: true,
} as const;

/**
 * The Prisma `select` shape for an indexable album (matches {@link AlbumRow}).
 * `primaryArtist` pulls the full {@link ARTIST_SELECT} so a single read produces
 * both the album document and its artist document — no second query per album.
 */
const ALBUM_SELECT = {
  id: true,
  spotifyId: true,
  mbid: true,
  title: true,
  releaseDate: true,
  coverUrl: true,
  popularityScore: true,
  primaryArtist: { select: ARTIST_SELECT },
  genres: { select: { genre: { select: { slug: true, name: true } } } },
} as const;

/**
 * Core of the Meilisearch write-through (PR7, design Decision #6). Queue-agnostic
 * and free of any BullMQ dependency — like {@link CatalogImportService} and
 * {@link MusicBrainzEnrichService} — so the "read a Postgres row, project it into
 * a Meili document" behavior is unit-testable against fakes with no live Redis,
 * Postgres, or Meilisearch.
 *
 * Two entry points:
 *  - {@link syncAlbum}: single-document incremental sync, driven by the
 *    `search-sync` queue as the catalog pipeline upserts albums. Reads the album
 *    (and its primary artist + genres) fresh from Postgres each time and upserts
 *    both the album and artist documents, so the projection always reflects the
 *    current DB state (idempotent, re-runnable).
 *  - {@link reindexAll}: full batch rebuild from Postgres, used by the
 *    `reindex:search` script — the authoritative way to (re)populate the index
 *    from scratch, e.g. after a bulk seed or if Meili's data is ever lost.
 */
@Injectable()
export class SearchSyncService {
  private readonly logger = new Logger(SearchSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meili: MeiliService,
  ) {}

  /**
   * Indexes a single album (looked up by its stable `spotifyId`, symmetric with
   * {@link MusicBrainzEnrichService.enrichAlbum}) and its primary artist into
   * Meilisearch. Reads the row fresh so it always reflects the latest catalog
   * state — an album synced right after upsert is searchable by title/artist;
   * re-synced after MusicBrainz enrichment it also carries genres.
   *
   * Returns `album-missing` (not an error) when the album no longer exists, e.g.
   * deleted between upsert and sync. Meili write failures PROPAGATE so the
   * enclosing `search-sync` BullMQ job retries via its standard backoff.
   */
  async syncAlbum(spotifyId: string): Promise<SyncAlbumResult> {
    const album = await this.prisma.client.album.findUnique({
      where: { spotifyId },
      select: ALBUM_SELECT,
    });
    if (!album) {
      return { status: "album-missing" };
    }

    // One read produces both documents: the album (which reads only
    // `primaryArtist.name`) and the artist (the full artist row selected above).
    await this.meili.indexAlbums([toAlbumDocument(album as AlbumRow)]);
    await this.meili.indexArtists([
      toArtistDocument(album.primaryArtist as ArtistRow),
    ]);
    return { status: "synced" };
  }

  /**
   * Rebuilds both indexes from Postgres in bounded batches (cursor-paginated by
   * id so it scales to a ~100k-album catalog without loading it all into
   * memory). Configures the index settings first, then clears stale documents so
   * rows deleted from Postgres since the last index don't linger.
   */
  async reindexAll(): Promise<ReindexResult> {
    await this.meili.configureIndexes();
    await this.meili.clearIndexes();

    const albums = await this.reindexAlbums();
    const artists = await this.reindexArtists();

    this.logger.log(
      `Search reindex complete: ${albums} album(s), ${artists} artist(s)`,
    );
    return { albums, artists };
  }

  private async reindexAlbums(): Promise<number> {
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const batch = await this.prisma.client.album.findMany({
        select: ALBUM_SELECT,
        orderBy: { id: "asc" },
        take: REINDEX_BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) {
        break;
      }
      await this.meili.indexAlbums(
        batch.map((album) => toAlbumDocument(album as AlbumRow)),
      );
      total += batch.length;
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < REINDEX_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }

  private async reindexArtists(): Promise<number> {
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const batch = await this.prisma.client.artist.findMany({
        select: ARTIST_SELECT,
        orderBy: { id: "asc" },
        take: REINDEX_BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) {
        break;
      }
      await this.meili.indexArtists(
        batch.map((artist) => toArtistDocument(artist as ArtistRow)),
      );
      total += batch.length;
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < REINDEX_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }
}
