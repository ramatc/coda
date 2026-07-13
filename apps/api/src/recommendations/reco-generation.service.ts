import { Injectable, Logger } from "@nestjs/common";
import { Prisma, RecommendationStatus } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ARTIST_WEIGHT,
  CANDIDATE_LIMIT,
  GENRE_WEIGHT,
  HIGH_RATING_THRESHOLD,
  MAX_ACTIVE_RECOMMENDATIONS,
  POPULARITY_WEIGHT,
  TASTE_ALBUM_GENRE_WEIGHT,
  TOP_GENRES_FOR_PREFILTER,
} from "./recommendations.constants.js";

/** Result of a generation run for one user. */
export interface RecoGenerationResult {
  /** Number of `ACTIVE` recommendations upserted for the user this run. */
  generated: number;
  /** Number of stale `ACTIVE` recommendations pruned (no longer in the top set). */
  pruned: number;
}

/** The per-recommendation "why" snapshot persisted to `Recommendation.reason`. */
export interface RecoReason {
  /** Human-facing name of the strongest matched genre, or `null`. */
  topGenre: string | null;
  /** Whether the album's primary artist is one the user favors. */
  matchedArtist: boolean;
}

/** A scored candidate album ready to persist as a recommendation. */
export interface ScoredCandidate {
  albumId: string;
  score: number;
  reason: RecoReason;
}

/** A user's derived taste profile (genre weights + artist affinity). */
export interface TasteProfile {
  /** Accumulated weight per genre id (onboarding prefs + tracked activity). */
  genreWeight: Map<string, number>;
  /** Sum of all genre weights — the normaliser for `genreOverlap`. */
  totalGenreWeight: number;
  /** Artist ids the user favors (favorites + highly-rated/favorited albums). */
  artistAffinity: Set<string>;
  /** The strongest genre ids, seeding the candidate SQL prefilter. */
  topGenreIds: string[];
}

/** A genre tag on a candidate album (id + its weight on that album). */
interface CandidateGenre {
  genreId: string;
  weight: number;
}

/** A candidate album as selected from the genre prefilter. */
interface CandidateAlbum {
  id: string;
  popularityScore: number;
  primaryArtistId: string;
  genres: CandidateGenre[];
}

/**
 * Scores a single candidate album against a taste profile using the design's
 * heuristic (exported pure so the weighting is unit-testable without Prisma):
 *
 * ```
 * score = 0.5*genreOverlap + 0.35*artistOverlap + 0.15*log-normPopularity
 * ```
 *
 * - `genreOverlap` = (sum of taste weight × album-genre weight over the album's
 *   genres that intersect the taste) / total taste genre weight, clamped to
 *   [0, 1]. Zero when the album shares no genre with the user's taste.
 * - `artistOverlap` = 1 when the album's primary artist is in the affinity set,
 *   else 0 (binary — Fase 1 keeps this simple; featured-artist affinity is out
 *   of scope).
 * - `popularity` = log1p(popularityScore) / log1p(maxCandidatePopularity), so a
 *   heavy-tailed popularity distribution is compressed and normalised to [0, 1]
 *   against the most-popular candidate in the same run.
 *
 * NO embeddings, pgvector, or vector similarity are involved (spec: "No
 * Embedding-Based Scoring") — only these three heuristic signals.
 */
export function scoreCandidate(
  album: CandidateAlbum,
  taste: TasteProfile,
  maxPopularity: number,
  genreNameById: Map<string, string>,
): ScoredCandidate {
  let matchedGenreWeight = 0;
  let bestGenreId: string | null = null;
  let bestGenreContribution = 0;

  for (const albumGenre of album.genres) {
    const tasteWeight = taste.genreWeight.get(albumGenre.genreId);
    if (tasteWeight === undefined) {
      continue;
    }
    const contribution = tasteWeight * albumGenre.weight;
    matchedGenreWeight += contribution;
    if (contribution > bestGenreContribution) {
      bestGenreContribution = contribution;
      bestGenreId = albumGenre.genreId;
    }
  }

  const genreOverlap =
    taste.totalGenreWeight > 0
      ? Math.min(matchedGenreWeight / taste.totalGenreWeight, 1)
      : 0;
  const artistOverlap = taste.artistAffinity.has(album.primaryArtistId) ? 1 : 0;
  const popularity =
    maxPopularity > 0
      ? Math.log1p(Math.max(album.popularityScore, 0)) / Math.log1p(maxPopularity)
      : 0;

  const score =
    GENRE_WEIGHT * genreOverlap +
    ARTIST_WEIGHT * artistOverlap +
    POPULARITY_WEIGHT * popularity;

  return {
    albumId: album.id,
    score,
    reason: {
      topGenre: bestGenreId ? genreNameById.get(bestGenreId) ?? null : null,
      matchedArtist: artistOverlap === 1,
    },
  };
}

/**
 * Recommendation generation (PR11, design Decision #7). Builds a user's taste
 * profile from their onboarding preferences plus tracked activity (favorites +
 * highly-rated albums), SQL-prefilters candidate albums by the user's strongest
 * genres, scores them with the heuristic {@link scoreCandidate}, and upserts the
 * top {@link MAX_ACTIVE_RECOMMENDATIONS} as `ACTIVE` `Recommendation` rows —
 * pruning any stale `ACTIVE` rows that fell out of the top set.
 *
 * Cold-start safe: a freshly-onboarded user with genre/artist preferences but no
 * tracked activity still yields recommendations, driven by their onboarding
 * preferences and popularity alone (spec: "Cold-start user without activity still
 * gets recommendations"). Dismiss-respecting: albums the user dismissed are
 * excluded from the candidate set, so a dismissed album never re-surfaces (spec:
 * "Dismissed recommendation does not reappear"). `DISMISSED` rows are never
 * touched by the prune (only `ACTIVE` rows are), so the dismissal persists.
 *
 * This is invoked both by the `reco-generation` BullMQ worker (the precompute
 * path) and synchronously as a cold-read fallback in {@link
 * import("./recommendations.service.js").RecommendationsService} — the algorithm
 * itself is identical either way.
 */
@Injectable()
export class RecoGenerationService {
  private readonly logger = new Logger(RecoGenerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateForUser(userId: string): Promise<RecoGenerationResult> {
    const taste = await this.buildTaste(userId);
    // No taste signal at all (user has no onboarding genre preferences) → there
    // is nothing to score against, so generate nothing rather than recommending
    // arbitrary popular albums. Onboarding guarantees >= MIN_GENRES before a user
    // reaches /home, so this only trips for a not-yet-onboarded account.
    if (taste.genreWeight.size === 0 || taste.topGenreIds.length === 0) {
      return { generated: 0, pruned: 0 };
    }

    const excludedAlbumIds = await this.collectExcludedAlbumIds(userId);
    const candidates = await this.fetchCandidates(
      taste.topGenreIds,
      excludedAlbumIds,
    );
    if (candidates.length === 0) {
      const pruned = await this.pruneStale(userId, []);
      return { generated: 0, pruned };
    }

    const genreNameById = await this.fetchGenreNames(taste.topGenreIds);
    const maxPopularity = candidates.reduce(
      (max, album) => Math.max(max, album.popularityScore),
      0,
    );

    const top = candidates
      .map((album) =>
        scoreCandidate(album, taste, maxPopularity, genreNameById),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ACTIVE_RECOMMENDATIONS);

    const pruned = await this.persist(userId, top);
    return { generated: top.length, pruned };
  }

  /**
   * Builds the taste profile: onboarding genre preferences (weighted) plus a
   * softer boost from the genres/artist of every album the user favorited or
   * rated highly (>= {@link HIGH_RATING_THRESHOLD}). Favorite artists count
   * directly toward artist affinity.
   */
  private async buildTaste(userId: string): Promise<TasteProfile> {
    const [genrePrefs, artistFavorites, albumFavorites, ratings] =
      await Promise.all([
        this.prisma.client.userGenrePreference.findMany({
          where: { userId },
          select: { genreId: true, weight: true },
        }),
        this.prisma.client.userArtistFavorite.findMany({
          where: { userId },
          select: { artistId: true },
        }),
        this.prisma.client.userAlbumFavorite.findMany({
          where: { userId },
          select: { albumId: true },
        }),
        this.prisma.client.rating.findMany({
          where: { userId },
          select: { albumId: true, score: true },
        }),
      ]);

    const genreWeight = new Map<string, number>();
    for (const pref of genrePrefs) {
      addWeight(genreWeight, pref.genreId, pref.weight);
    }

    const artistAffinity = new Set<string>();
    for (const favorite of artistFavorites) {
      artistAffinity.add(favorite.artistId);
    }

    // Albums that positively signal taste: explicit favorites + highly-rated.
    const tasteAlbumIds = new Set<string>(
      albumFavorites.map((favorite) => favorite.albumId),
    );
    for (const rating of ratings) {
      if (rating.score >= HIGH_RATING_THRESHOLD) {
        tasteAlbumIds.add(rating.albumId);
      }
    }

    if (tasteAlbumIds.size > 0) {
      const tasteAlbums = await this.prisma.client.album.findMany({
        where: { id: { in: [...tasteAlbumIds] } },
        select: {
          primaryArtistId: true,
          genres: { select: { genreId: true, weight: true } },
        },
      });
      for (const album of tasteAlbums) {
        artistAffinity.add(album.primaryArtistId);
        for (const albumGenre of album.genres) {
          addWeight(
            genreWeight,
            albumGenre.genreId,
            albumGenre.weight * TASTE_ALBUM_GENRE_WEIGHT,
          );
        }
      }
    }

    const totalGenreWeight = [...genreWeight.values()].reduce(
      (sum, weight) => sum + weight,
      0,
    );
    const topGenreIds = [...genreWeight.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_GENRES_FOR_PREFILTER)
      .map(([genreId]) => genreId);

    return { genreWeight, totalGenreWeight, artistAffinity, topGenreIds };
  }

  /**
   * The albums a candidate must NOT be: anything the user already listened to or
   * rated (they have already engaged with it), plus anything they dismissed (so
   * a dismissed recommendation never reappears). Favorites are already excluded
   * transitively — a favorited album is either listened/rated or, if not, still
   * a poor recommendation — but we exclude them explicitly for clarity.
   */
  private async collectExcludedAlbumIds(userId: string): Promise<string[]> {
    const [listens, ratings, favorites, dismissed] = await Promise.all([
      this.prisma.client.listen.findMany({
        where: { userId },
        select: { albumId: true },
      }),
      this.prisma.client.rating.findMany({
        where: { userId },
        select: { albumId: true },
      }),
      this.prisma.client.userAlbumFavorite.findMany({
        where: { userId },
        select: { albumId: true },
      }),
      this.prisma.client.recommendation.findMany({
        where: { userId, status: RecommendationStatus.DISMISSED },
        select: { albumId: true },
      }),
    ]);

    const excluded = new Set<string>();
    for (const row of [...listens, ...ratings, ...favorites, ...dismissed]) {
      excluded.add(row.albumId);
    }
    return [...excluded];
  }

  /**
   * SQL-prefilters candidate albums: those tagged with any of the user's top
   * genres, excluding the user's already-tracked/dismissed albums, ordered by
   * popularity so the most surfaced-worthy albums are scored first, capped at
   * {@link CANDIDATE_LIMIT}. This is the "join AlbumGenre on the user's top
   * genres" prefilter from the design, expressed via Prisma's relation filter.
   */
  private async fetchCandidates(
    topGenreIds: string[],
    excludedAlbumIds: string[],
  ): Promise<CandidateAlbum[]> {
    return this.prisma.client.album.findMany({
      where: {
        genres: { some: { genreId: { in: topGenreIds } } },
        ...(excludedAlbumIds.length > 0
          ? { id: { notIn: excludedAlbumIds } }
          : {}),
      },
      select: {
        id: true,
        popularityScore: true,
        primaryArtistId: true,
        genres: { select: { genreId: true, weight: true } },
      },
      orderBy: { popularityScore: "desc" },
      take: CANDIDATE_LIMIT,
    });
  }

  /** Maps the top genre ids to human-facing names for the `reason` snapshot. */
  private async fetchGenreNames(
    genreIds: string[],
  ): Promise<Map<string, string>> {
    const genres = await this.prisma.client.genre.findMany({
      where: { id: { in: genreIds } },
      select: { id: true, name: true },
    });
    return new Map(genres.map((genre) => [genre.id, genre.name]));
  }

  /**
   * Persists the run: prunes stale `ACTIVE` rows no longer in the top set, then
   * bulk-upserts every scored candidate as `ACTIVE`. Runs in one transaction so
   * a home read never observes a half-pruned set. The candidate set already
   * excludes dismissed albums, so no upsert here can resurrect a `DISMISSED`
   * row.
   *
   * Round-trip cost (judgment-day fix, round 2): this method is reached
   * SYNCHRONOUSLY on `GET /recommendations` for any user with zero `ACTIVE`
   * recommendations — see the cold-read fallback in {@link
   * import("./recommendations.service.js").RecommendationsService} — so it
   * must stay cheap on the request path. The prune is a single `deleteMany`;
   * the upserts are a single bulk `INSERT ... ON CONFLICT` (see {@link
   * upsertBatch}) instead of up to {@link MAX_ACTIVE_RECOMMENDATIONS} (~50)
   * sequential `upsert()` round-trips awaited one at a time in a `for` loop —
   * that per-row loop risked exhausting Prisma's default 5s interactive
   * transaction timeout under any real network latency, turning a cold-start
   * `GET /recommendations` into a 500. Do not revert to a per-row loop "for
   * clarity": that reintroduces the timeout risk this fix removes.
   */
  private async persist(
    userId: string,
    top: ScoredCandidate[],
  ): Promise<number> {
    const topAlbumIds = top.map((candidate) => candidate.albumId);
    return this.prisma.client.$transaction(async (tx) => {
      const pruned = await tx.recommendation.deleteMany({
        where: {
          userId,
          status: RecommendationStatus.ACTIVE,
          ...(topAlbumIds.length > 0 ? { albumId: { notIn: topAlbumIds } } : {}),
        },
      });
      await this.upsertBatch(tx, userId, top);
      return pruned.count;
    });
  }

  /**
   * Bulk-upserts every scored candidate for `userId` in ONE round-trip, via a
   * native Postgres `INSERT ... ON CONFLICT (user_id, album_id) DO UPDATE`
   * over `UNNEST`-ed arrays. Prisma's query builder has no bulk-upsert
   * primitive that lets each row carry its own `score`/`reason`, so raw SQL is
   * used here specifically to replace what was a sequential per-row
   * `tx.recommendation.upsert()` loop (judgment-day fix, round 2 — see {@link
   * persist}). `gen_random_uuid()` has been built into Postgres core since v13
   * (this project targets Postgres 17, see `docker-compose.yml`), so no
   * extension is required.
   */
  private async upsertBatch(
    tx: Prisma.TransactionClient,
    userId: string,
    top: ScoredCandidate[],
  ): Promise<void> {
    if (top.length === 0) {
      return;
    }
    const albumIds = top.map((candidate) => candidate.albumId);
    const scores = top.map((candidate) => candidate.score);
    const reasons = top.map((candidate) => JSON.stringify(candidate.reason));
    await tx.$executeRaw`
      INSERT INTO recommendations (id, user_id, album_id, score, reason, status, generated_at)
      SELECT gen_random_uuid(), ${userId}::uuid, data.album_id, data.score, data.reason::jsonb, 'ACTIVE'::"recommendation_status", now()
      FROM UNNEST(${albumIds}::uuid[], ${scores}::float8[], ${reasons}::text[]) AS data(album_id, score, reason)
      ON CONFLICT (user_id, album_id) DO UPDATE SET
        score = EXCLUDED.score,
        reason = EXCLUDED.reason,
        status = 'ACTIVE'::"recommendation_status",
        generated_at = EXCLUDED.generated_at
    `;
  }

  /** Prunes all stale `ACTIVE` rows when a run produced no candidates. */
  private async pruneStale(
    userId: string,
    keepAlbumIds: string[],
  ): Promise<number> {
    const pruned = await this.prisma.client.recommendation.deleteMany({
      where: {
        userId,
        status: RecommendationStatus.ACTIVE,
        ...(keepAlbumIds.length > 0 ? { albumId: { notIn: keepAlbumIds } } : {}),
      },
    });
    return pruned.count;
  }
}

/** Adds `delta` to the running weight for `key` in `map` (0 when absent). */
function addWeight(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}
