import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RecommendationStatus } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecoGenerationService } from "./reco-generation.service.js";
import { UUID_PATTERN } from "./recommendations.constants.js";

/** The album a recommendation points at. */
export interface RecommendationAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseYear: number | null;
  primaryArtistName: string;
}

/** Why an album was recommended (mirrors {@link import("./reco-generation.service.js").RecoReason}). */
export interface RecommendationReason {
  topGenre: string | null;
  matchedArtist: boolean;
}

/** One surfaced recommendation for `/home`. */
export interface RecommendationItem {
  id: string;
  score: number;
  reason: RecommendationReason;
  album: RecommendationAlbum;
}

interface RecommendationRow {
  id: string;
  score: number;
  reason: unknown;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    releaseDate: Date | null;
    primaryArtist: { name: string };
  };
}

/**
 * Recommendations read + dismiss surface (PR11), backing `GET /recommendations`
 * and `POST /recommendations/:id/dismiss`. Runs behind the global `ClerkGuard`;
 * the controller passes the verified Clerk user id.
 *
 * Reads the `ACTIVE` `Recommendation` rows the generation worker precomputes
 * (design Decision #7 — fast home render off a precomputed projection). As with
 * the album-detail and activity reads (PR9/PR10), the caller's LOCAL `User` row
 * may not be synced yet — the read degrades to an empty list rather than a 404
 * (an unsynced account has no recommendations anyway). The dismiss WRITE path,
 * by contrast, 404s an unsynced user, mirroring the tracking write paths.
 *
 * Cold-read fallback: if a synced, onboarded user has no `ACTIVE` recommendations
 * yet (the async generation worker has not run — e.g. it is not deployed in this
 * environment, or the onboarding-trigger job is still queued), generation runs
 * SYNCHRONOUSLY on the read so `/home` is never empty for a user who has
 * completed onboarding (spec: "WHEN they view /home THEN recommendations are
 * generated"). The precompute path keeps steady-state reads fast; this fallback
 * only pays the generation cost on the first cold read.
 *
 * Known Fase 1 MVP gap (documented, not fixed): like the catalog-import and
 * search-sync workers before it, the standalone `reco-worker.ts` process (which
 * owns both the `reco-generation` queue consumer and the nightly full-refresh
 * cron) is NOT wired into `docker-compose.yml` or CI. In practice this means the
 * synchronous cold-read fallback below is likely the PRIMARY code path that
 * generates recommendations in dev and most deployments today, not merely a rare
 * rescue path for a not-yet-processed queue job — worth knowing before assuming
 * the precompute path is doing the steady-state work it was designed for.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: RecoGenerationService,
  ) {}

  /**
   * The caller's active recommendations, strongest score first. Empty when the
   * local user is unsynced. When empty for a synced user, a synchronous
   * generation is attempted once (cold-read fallback) before returning.
   */
  async getRecommendations(clerkUserId: string): Promise<RecommendationItem[]> {
    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      return [];
    }

    let rows = await this.readActive(userId);
    if (rows.length === 0) {
      // Cold read: no precomputed recommendations yet. Generate on the spot so a
      // freshly-onboarded user still sees results. Best-effort — if generation
      // yields nothing (user not onboarded, or an empty catalog), return empty.
      await this.generation.generateForUser(userId);
      rows = await this.readActive(userId);
    }

    return rows.map((row) => this.toItem(row));
  }

  /**
   * Dismisses one of the caller's recommendations: flips it to `DISMISSED` and
   * stamps `dismissedAt`, so future generation runs exclude its album (spec:
   * "Dismissed recommendation does not reappear"). Scoped to the caller's own
   * rows — a caller can never dismiss another user's recommendation. A 404 is
   * returned when the id is unknown or not the caller's (indistinguishable on
   * purpose, so it does not leak the existence of another user's row).
   */
  async dismiss(
    clerkUserId: string,
    recommendationId: unknown,
  ): Promise<{ id: string; status: RecommendationStatus }> {
    const userId = await this.requireUserId(clerkUserId);
    const id = this.validateId(recommendationId);

    // Scope the flip to the caller's own row. `updateMany` returns a count
    // (never throws on a no-match), so a 0-count cleanly maps to a 404 without a
    // pre-check race — and re-dismissing an already-dismissed row is idempotent.
    const result = await this.prisma.client.recommendation.updateMany({
      where: { id, userId },
      data: {
        status: RecommendationStatus.DISMISSED,
        dismissedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new NotFoundException("Recommendation not found");
    }
    return { id, status: RecommendationStatus.DISMISSED };
  }

  /** Reads the caller's `ACTIVE` recommendations, strongest score first. */
  private async readActive(userId: string): Promise<RecommendationRow[]> {
    return this.prisma.client.recommendation.findMany({
      where: { userId, status: RecommendationStatus.ACTIVE },
      orderBy: [{ score: "desc" }, { generatedAt: "desc" }],
      select: {
        id: true,
        score: true,
        reason: true,
        album: {
          select: {
            id: true,
            title: true,
            coverUrl: true,
            releaseDate: true,
            primaryArtist: { select: { name: true } },
          },
        },
      },
    }) as Promise<RecommendationRow[]>;
  }

  private toItem(row: RecommendationRow): RecommendationItem {
    return {
      id: row.id,
      score: row.score,
      reason: normalizeReason(row.reason),
      album: {
        id: row.album.id,
        title: row.album.title,
        coverUrl: row.album.coverUrl,
        releaseYear: row.album.releaseDate
          ? row.album.releaseDate.getUTCFullYear()
          : null,
        primaryArtistName: row.album.primaryArtist.name,
      },
    };
  }

  /**
   * Resolves the local `User.id`, or `null` when unsynced (read paths degrade to
   * an empty list — the same read/write asymmetry as PR9/PR10).
   */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Resolves the local `User.id`, or throws 404 (write paths, e.g. dismiss). */
  private async requireUserId(clerkUserId: string): Promise<string> {
    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      throw new NotFoundException({
        message: "No user found for the current session",
        code: "ACCOUNT_NOT_SYNCED",
      });
    }
    return userId;
  }

  /** Validates a UUID-shaped id before it reaches Postgres (clean 400). */
  private validateId(value: unknown): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException("id must be a valid id.");
  }
}

/** Coerces a persisted `reason` JSON blob into the typed shape, tolerating null. */
function normalizeReason(reason: unknown): RecommendationReason {
  if (reason && typeof reason === "object") {
    const record = reason as Record<string, unknown>;
    return {
      topGenre: typeof record.topGenre === "string" ? record.topGenre : null,
      matchedArtist: record.matchedArtist === true,
    };
  }
  return { topGenre: null, matchedArtist: false };
}
