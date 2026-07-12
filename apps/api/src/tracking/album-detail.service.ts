import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { UUID_PATTERN } from "./tracking.constants.js";
import {
  computeAggregateRating,
  type RatingAggregate,
} from "./rating-aggregate.util.js";

/** A single track on the album's tracklist. */
export interface AlbumDetailTrack {
  id: string;
  position: number;
  title: string;
  durationMs: number | null;
}

/** A genre tag attached to the album. */
export interface AlbumDetailGenre {
  id: string;
  slug: string;
  name: string;
}

/** The album's aggregate rating (mean + count) across every user. */
export type AlbumAggregateRating = RatingAggregate;

/**
 * The current viewer's own tracking state for this album — everything the
 * detail page's action island needs to render its controls in the right state
 * (already listened? already rated? already reviewed?). Every field is empty
 * for a viewer who has not tracked the album (or whose local `User` row does
 * not exist yet — see {@link AlbumDetailService.getAlbumDetail}).
 */
export interface AlbumViewerState {
  listened: boolean;
  /** Id of the viewer's most recent `Listen`, for the delete-listen control. */
  listenId: string | null;
  /** The viewer's own rating score (1-10), or `null` if unrated. */
  score: number | null;
  /** The viewer's own plain-text review body, or `null` if unreviewed. */
  review: string | null;
}

/** The full album-detail payload consumed by `apps/web/app/albums/[id]`. */
export interface AlbumDetail {
  id: string;
  title: string;
  coverUrl: string | null;
  /** ISO `YYYY-MM-DD` release date, or `null` when unknown. */
  releaseDate: string | null;
  /** Release year derived from {@link releaseDate}, or `null`. */
  releaseYear: number | null;
  trackCount: number | null;
  primaryArtist: { id: string; name: string };
  genres: AlbumDetailGenre[];
  tracks: AlbumDetailTrack[];
  aggregateRating: AlbumAggregateRating;
  viewer: AlbumViewerState;
}

/**
 * Read side of album tracking (PR9): the single query that backs the album
 * detail page (`/albums/[id]`). It returns EVERYTHING the page renders in ONE
 * response — album metadata, tracklist, genres, the aggregate rating, and the
 * current viewer's own tracking state — so the server component makes a single
 * round-trip (design Decision #9, server-first data flow). The write side
 * (mark listened / rate / review) stays in {@link TrackingService}; this
 * service is read-only and depends on {@link PrismaService} alone.
 *
 * Runs behind the global `ClerkGuard`, so a viewer is always authenticated.
 * The viewer's LOCAL `User` row, however, may not exist yet (the Clerk webhook
 * sync is eventually consistent) — in that case the album still renders with an
 * empty viewer state rather than 404-ing a perfectly valid album page. Only an
 * unknown ALBUM id is a 404.
 */
@Injectable()
export class AlbumDetailService {
  constructor(private readonly prisma: PrismaService) {}

  async getAlbumDetail(
    clerkUserId: string,
    albumId: unknown,
  ): Promise<AlbumDetail> {
    const id = this.validateId(albumId);

    const album = await this.prisma.client.album.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        coverUrl: true,
        releaseDate: true,
        trackCount: true,
        primaryArtist: { select: { id: true, name: true } },
        genres: {
          select: { genre: { select: { id: true, slug: true, name: true } } },
        },
        tracks: {
          select: { id: true, position: true, title: true, durationMs: true },
          orderBy: { position: "asc" },
        },
      },
    });
    if (!album) {
      throw new NotFoundException(`Unknown album: ${id}`);
    }

    const [aggregate, viewer] = await Promise.all([
      computeAggregateRating(this.prisma, id),
      this.resolveViewerState(clerkUserId, id),
    ]);

    const releaseDate = album.releaseDate
      ? album.releaseDate.toISOString().slice(0, 10)
      : null;

    return {
      id: album.id,
      title: album.title,
      coverUrl: album.coverUrl,
      releaseDate,
      releaseYear: album.releaseDate ? album.releaseDate.getUTCFullYear() : null,
      trackCount: album.trackCount,
      primaryArtist: album.primaryArtist,
      genres: album.genres.map((g) => g.genre),
      tracks: album.tracks,
      aggregateRating: aggregate,
      viewer,
    };
  }

  /**
   * Resolves the viewer's own tracking state for the album. Degrades to an
   * empty state (not a 404) when the Clerk id has no local `User` row yet, so a
   * valid album page never breaks on an unsynced session.
   */
  private async resolveViewerState(
    clerkUserId: string,
    albumId: string,
  ): Promise<AlbumViewerState> {
    const empty: AlbumViewerState = {
      listened: false,
      listenId: null,
      score: null,
      review: null,
    };

    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      return empty;
    }

    const [listen, rating, review] = await Promise.all([
      this.prisma.client.listen.findFirst({
        where: { userId: user.id, albumId },
        orderBy: { listenedAt: "desc" },
        select: { id: true },
      }),
      this.prisma.client.rating.findUnique({
        where: { userId_albumId: { userId: user.id, albumId } },
        select: { score: true },
      }),
      this.prisma.client.review.findUnique({
        where: { userId_albumId: { userId: user.id, albumId } },
        select: { body: true },
      }),
    ]);

    return {
      listened: listen !== null,
      listenId: listen?.id ?? null,
      score: rating?.score ?? null,
      review: review?.body ?? null,
    };
  }

  /** Validates a UUID-shaped id before it reaches Postgres (clean 400). */
  private validateId(value: unknown): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException("albumId must be a valid id.");
  }
}
