import type { PrismaService } from "../prisma/prisma.service.js";

/** An album's aggregate rating (mean + count) across every user. */
export interface RatingAggregate {
  average: number | null;
  count: number;
}

/**
 * Computes an album's aggregate rating (mean + count) straight from the
 * `Rating` table — the single source of truth, so an edited/deleted rating is
 * always reflected without a denormalized counter to keep in sync. Shared by
 * {@link TrackingService} (write-side, returned after a rating mutation) and
 * {@link AlbumDetailService} (read-side, the album detail page) so both surface
 * the exact same number for the same album (judgment-day PR9 round 2, issue
 * #5 — previously each service had its own identical copy of this query).
 */
export async function computeAggregateRating(
  prisma: PrismaService,
  albumId: string,
): Promise<RatingAggregate> {
  const result = await prisma.client.rating.aggregate({
    where: { albumId },
    _avg: { score: true },
    _count: { _all: true },
  });
  return {
    average: result._avg.score ?? null,
    count: result._count._all,
  };
}
