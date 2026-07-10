import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { MusicBrainzClient } from "./musicbrainz.client.js";

/** Outcome of a single album's enrichment attempt. */
export type EnrichResult =
  | { status: "enriched"; mbid: string; genres: number }
  | { status: "no-match" }
  | { status: "album-missing" }
  | { status: "already-enriched"; mbid: string };

/**
 * Core of the MusicBrainz enrichment leg (PR6, design Decision #4). Queue-agnostic
 * and free of any BullMQ dependency — exactly like {@link CatalogImportService} —
 * so the "enrich an album by its Spotify id, keyed on `mbid`" behavior is
 * unit-testable against fakes without a live Redis, Postgres, or MusicBrainz.
 *
 * It reads a seeded album (written by the PR5 Spotify leg) by its unique
 * `spotifyId`, resolves its MusicBrainz release-group via {@link MusicBrainzClient}
 * (rate-limited ≤1 req/s), and upserts the enrichment: the album's `mbid`, its
 * primary artist's `mbid`, and its genres (`Genre` + `AlbumGenre`). Genres are
 * upserted by their unique `slug`, so they unify with the onboarding genre
 * taxonomy and across albums.
 */
@Injectable()
export class MusicBrainzEnrichService {
  private readonly logger = new Logger(MusicBrainzEnrichService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly musicbrainz: MusicBrainzClient,
  ) {}

  /**
   * Enriches the album with the given Spotify id from MusicBrainz.
   *
   * Idempotent: re-running writes the same `mbid`/genres in place (the album is
   * matched by its own id, so re-setting its existing mbid is a no-op, and
   * genre links are upserted by composite key, with stale links from a shrunk
   * genre set removed). Returns a benign `no-match` when MusicBrainz has no
   * candidate, `album-missing` when the album is no longer present (e.g.
   * deleted between seed and enrich), or `already-enriched` when the album's
   * `mbid` is already set — skipping the MusicBrainz network call entirely
   * (judgment-day issue #3). This is a service-level defense-in-depth check on
   * top of (not a replacement for) BullMQ's job-id dedup: it also protects
   * direct/manual calls to this service and calls made after the dedup window
   * has aged out. None of these three are errors.
   *
   * DB failures (including a P2002 when the resolved `mbid` is already claimed
   * by a different album/artist edition) PROPAGATE so the caller can isolate/
   * retry them — mirroring how {@link CatalogImportService.upsertAlbum} leaves
   * error handling to its callers.
   */
  async enrichAlbum(spotifyId: string): Promise<EnrichResult> {
    const album = await this.prisma.client.album.findUnique({
      where: { spotifyId },
      select: {
        id: true,
        title: true,
        mbid: true,
        primaryArtist: { select: { id: true, name: true } },
      },
    });
    if (!album) {
      return { status: "album-missing" };
    }
    if (album.mbid) {
      return { status: "already-enriched", mbid: album.mbid };
    }

    const enrichment = await this.musicbrainz.lookupAlbum(
      album.title,
      album.primaryArtist.name,
    );
    if (!enrichment) {
      return { status: "no-match" };
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.album.update({
        where: { id: album.id },
        data: { mbid: enrichment.mbid },
      });

      if (enrichment.artist) {
        await tx.artist.update({
          where: { id: album.primaryArtist.id },
          data: { mbid: enrichment.artist.mbid },
        });
      }

      const currentGenreIds: string[] = [];
      for (const genre of enrichment.genres) {
        const row = await tx.genre.upsert({
          where: { slug: genre.slug },
          create: { slug: genre.slug, name: genre.name },
          update: {},
          select: { id: true },
        });
        currentGenreIds.push(row.id);
        await tx.albumGenre.upsert({
          where: { albumId_genreId: { albumId: album.id, genreId: row.id } },
          create: { albumId: album.id, genreId: row.id, weight: genre.weight },
          update: { weight: genre.weight },
        });
      }
      // Remove stale AlbumGenre links left over from a prior enrichment whose
      // genre set has since shrunk (judgment-day issue #5) — without this, the
      // "idempotent" claim above breaks the moment a re-run (manual retry, or
      // MusicBrainz data changing upstream) produces fewer genres than before.
      await tx.albumGenre.deleteMany({
        where: { albumId: album.id, genreId: { notIn: currentGenreIds } },
      });
    });

    this.logger.log(
      `Enriched album ${spotifyId} → mbid ${enrichment.mbid} ` +
        `(${enrichment.genres.length} genre(s))`,
    );
    return {
      status: "enriched",
      mbid: enrichment.mbid,
      genres: enrichment.genres.length,
    };
  }
}
