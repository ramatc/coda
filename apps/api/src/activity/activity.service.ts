import { BadRequestException, Injectable } from "@nestjs/common";
import { ActivityType } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  UUID_PATTERN,
} from "./activity.constants.js";

/** Query options accepted by {@link ActivityService.getOwnActivity}. */
export interface ActivityQuery {
  /** Opaque cursor (a previous item's `id`); returns the page AFTER it. */
  cursor?: string;
  /** Requested page size (clamped to [1, {@link MAX_ACTIVITY_LIMIT}]). */
  limit?: string | number;
}

/** The album an activity event refers to (always present — a required FK). */
export interface ActivityItemAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** One entry in the personal activity stream. */
export interface ActivityItem {
  id: string;
  type: ActivityType;
  occurredAt: string;
  album: ActivityItemAlbum;
  /**
   * The rated score (1-10) for a RATING event, read from the event's own
   * `payload` snapshot so it survives even if the underlying `Rating` row was
   * later deleted (design Decision #10 stores the score on the event for
   * join-free, orphan-safe rendering). `null` for non-rating events.
   */
  score: number | null;
  /**
   * The review body for a REVIEW event, or `null`. Read from the `Review`
   * relation, which is `SetNull` — so a review deleted after the event was
   * emitted degrades this to `null` rather than crashing the feed (the
   * stranded-event edge case).
   */
  reviewBody: string | null;
}

/** A single cursor-paginated page of the caller's own activity. */
export interface ActivityPage {
  items: ActivityItem[];
  /** Cursor for the next (older) page, or `null` when this is the last page. */
  nextCursor: string | null;
}

interface ActivityEventRow {
  id: string;
  type: ActivityType;
  occurredAt: Date;
  payload: unknown;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtist: { name: string };
  };
  review: { body: string } | null;
}

/**
 * Personal activity stream (PR10): backs `GET /me/activity`. Returns ONLY the
 * authenticated caller's own `ActivityEvent`s (listens, ratings, reviews) in
 * reverse-chronological order, cursor paginated. It never fans out to any other
 * user's activity — the Fase 1 feed is strictly personal, and the `Follow`
 * model stays unused (spec: "No Social Fan-Out"). The Fase 2 social feed will
 * live at a separate `/feed` route, so this endpoint is deliberately NOT `/feed`.
 *
 * Runs behind the global `ClerkGuard`, so the caller is always authenticated.
 * As with the album-detail read (PR9), the caller's LOCAL `User` row may not
 * exist yet (the Clerk webhook sync is eventually consistent) — in that case the
 * stream is simply empty rather than a 404, since an unsynced account has no
 * activity to show anyway.
 *
 * Rendering is orphan-safe: the RATING score comes from the event's own
 * `payload` snapshot (survives a later rating delete) and the review body comes
 * from a `SetNull` relation that degrades to `null` — a stranded event never
 * crashes the feed. The `album` relation is a required, non-nullable FK, so an
 * item always has an album to link to.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnActivity(
    clerkUserId: string,
    query: ActivityQuery = {},
  ): Promise<ActivityPage> {
    const limit = this.resolveLimit(query.limit);
    const cursor = this.resolveCursor(query.cursor);

    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      // Local user row not synced yet — no activity to show.
      return { items: [], nextCursor: null };
    }

    // Fetch one extra row to detect whether a further page exists without a
    // second count query. The secondary `id` sort makes the ordering
    // deterministic when two events share the same `occurredAt`, so the cursor
    // never skips or repeats a row across page boundaries.
    //
    // `cursor` is intentionally NOT scoped by `{ userId }` when Prisma resolves
    // the anchor row: this cannot leak another user's activity (the `where`
    // below still filters every returned row by the caller's own userId), and
    // at most lets a caller who already knows another user's unguessable
    // ActivityEvent UUID pivot their own pagination window — informational,
    // not exploitable (judgment-day PR10 round 2, finding #5).
    //
    // A well-formed cursor id that doesn't match any row (e.g. a stale cursor
    // after the anchor event was removed) resolves to an empty page rather
    // than throwing: Prisma's cursor anchor lookup is a scalar comparison
    // against the anchor row's sort-key values, which is NULL when no row
    // matches, so the WHERE clause matches nothing (verified against Prisma's
    // documented cursor-pagination semantics; see `activity.service.spec.ts`).
    // This reasoning — and the tie-break test above it — is proven against an
    // in-memory Prisma fake, not a live Postgres round-trip; no
    // `activity.e2e.spec.ts` exists yet (unlike search/auth-guard/health).
    // Accepted residual risk for Fase 1 (judgment-day PR10 round 2, finding
    // #4) — add a live e2e test here first if this pagination ever misbehaves
    // in practice.
    const rows = (await this.prisma.client.activityEvent.findMany({
      where: { userId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        occurredAt: true,
        payload: true,
        album: {
          select: {
            id: true,
            title: true,
            coverUrl: true,
            primaryArtist: { select: { name: true } },
          },
        },
        review: { select: { body: true } },
      },
    })) as ActivityEventRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => this.toItem(row)),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  private toItem(row: ActivityEventRow): ActivityItem {
    return {
      id: row.id,
      type: row.type,
      occurredAt: row.occurredAt.toISOString(),
      album: {
        id: row.album.id,
        title: row.album.title,
        coverUrl: row.album.coverUrl,
        primaryArtistName: row.album.primaryArtist.name,
      },
      score:
        row.type === ActivityType.RATING ? extractScore(row.payload) : null,
      reviewBody: row.review?.body ?? null,
    };
  }

  /**
   * Resolves the local `User.id` for a Clerk user id, or `null` when no local
   * row exists yet (unlike the write paths' `resolveUserId`, this read degrades
   * to an empty stream instead of a 404 — same read/write asymmetry as the
   * album-detail page, PR9).
   */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Clamps the requested page size to [1, MAX], defaulting when unspecified. */
  private resolveLimit(value: string | number | undefined): number {
    if (value === undefined || value === "") {
      return DEFAULT_ACTIVITY_LIMIT;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException("limit must be a positive integer.");
    }
    return Math.min(parsed, MAX_ACTIVITY_LIMIT);
  }

  /** Validates the cursor's UUID shape (clean 400) before it reaches Postgres. */
  private resolveCursor(value: string | undefined): string | null {
    if (value === undefined || value === "") {
      return null;
    }
    const trimmed = value.trim();
    if (!UUID_PATTERN.test(trimmed)) {
      throw new BadRequestException("cursor must be a valid id.");
    }
    return trimmed;
  }
}

/**
 * Reads a numeric `score` off an event's JSON `payload` snapshot, tolerating a
 * null/absent/malformed payload — a stranded RATING event whose payload never
 * carried a score simply renders without one rather than throwing.
 */
function extractScore(payload: unknown): number | null {
  if (payload && typeof payload === "object" && "score" in payload) {
    const score = (payload as { score: unknown }).score;
    if (typeof score === "number" && Number.isFinite(score)) {
      return score;
    }
  }
  return null;
}
