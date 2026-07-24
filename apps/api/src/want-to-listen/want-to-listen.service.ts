import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import { UUID_PATTERN } from "./want-to-listen.constants.js";

/** Payload accepted by {@link WantToListenService.markAlbum}. */
export interface MarkInput {
  albumId?: unknown;
}

/** The raw row returned when a user marks an album as want-to-listen. */
export interface WantToListenRow {
  id: string;
  albumId: string;
  createdAt: string;
}

/**
 * One entry on a user's want-to-listen profile section, with its album
 * denormalized for render (mirrors the lists module's `ListItemView`).
 */
export interface WantToListenEntry {
  id: string;
  albumId: string;
  createdAt: string;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtistName: string;
  };
}

/**
 * Manual "want to listen" backlog (Fase 2 slice 2). Mirrors the `lists` module's
 * flat shape — one service owns all Prisma access and manual `unknown`-typed
 * validation with a local {@link UUID_PATTERN}, running behind the global
 * `ClerkGuard`. Separate from `lists` on purpose (design decision): a backlog is
 * a different domain from a curated list — no ordering, no visibility flags, no
 * shared logic.
 *
 * Auto-resolve is READ-TIME (design decision): a `WantToListen` row is NEVER
 * deleted when the user logs a `Listen` or `Rating`; instead {@link
 * getUserWantToListen} anti-joins the rows against the user's Listens and
 * Ratings so a resolved album drops out of the read. Because the row survives
 * resolution, deleting the resolving Listen/Rating naturally resurfaces the
 * album on the next read.
 */
@Injectable()
export class WantToListenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Marks an album as want-to-listen for the caller. Requires a synced local
   * `User` row (an unsynced caller is a 404, matching the tracking/lists write
   * paths). A second mark of the same album violates `@@unique([userId,
   * albumId])` (P2002) and is mapped to a 409. An `albumId` that doesn't
   * reference a real `Album` violates the FK (P2003) and is mapped to a 404.
   */
  async markAlbum(
    clerkUserId: string,
    input: MarkInput,
  ): Promise<WantToListenRow> {
    const userId = await this.requireCallerId(clerkUserId);
    const albumId = this.validateAlbumId(input.albumId);

    try {
      const row = await this.prisma.client.wantToListen.create({
        data: { userId, albumId },
        select: { id: true, albumId: true, createdAt: true },
      });
      return {
        id: row.id,
        albumId: row.albumId,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (err) {
      // `WantToListen.userId` is `@map("user_id")`, so the driver-adapter
      // reports the RAW snake_case column `user_id` for the
      // `@@unique([userId, albumId])` conflict — NOT the camelCase field name
      // (PR2 judgment-day Round 2 gotcha). Compare against the mapped column.
      if (
        isUniqueConstraintViolation(err) &&
        extractUniqueConstraintField(err) === "user_id"
      ) {
        throw new ConflictException(
          "This album is already on your want-to-listen list.",
        );
      }
      if (isForeignKeyViolation(err)) {
        throw new NotFoundException("Album not found.");
      }
      throw err;
    }
  }

  /**
   * Removes the caller's own want-to-listen entry for an album. The delete is
   * scoped by `userId` AND `albumId` (`deleteMany` + `count === 0 → 404`), so a
   * caller can only ever remove their OWN row — attempting to remove an album
   * they haven't marked (or another user's row) is a 404, never touching a
   * different user's data.
   */
  async unmarkAlbum(clerkUserId: string, albumId: unknown): Promise<void> {
    const userId = await this.requireCallerId(clerkUserId);
    const id = this.validateAlbumId(albumId);

    const { count } = await this.prisma.client.wantToListen.deleteMany({
      where: { userId, albumId: id },
    });
    if (count === 0) {
      throw new NotFoundException("Want-to-listen entry not found.");
    }
  }

  /**
   * Returns `username`'s want-to-listen backlog for their public profile
   * section: their rows anti-joined against their OWN Listens and Ratings, so an
   * album they've already listened to or rated drops out (read-time
   * auto-resolve). Newest first. An unknown username is a 404; an empty backlog
   * is an empty array, not an error. The section is public — the caller's
   * identity does not filter the result.
   */
  async getUserWantToListen(username: string): Promise<WantToListenEntry[]> {
    const targetId = await this.requireTargetId(username);

    const [rows, listens, ratings] = await Promise.all([
      this.prisma.client.wantToListen.findMany({
        where: { userId: targetId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          albumId: true,
          createdAt: true,
          album: {
            select: {
              id: true,
              title: true,
              coverUrl: true,
              primaryArtist: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.client.listen.findMany({
        where: { userId: targetId },
        select: { albumId: true },
        distinct: ["albumId"],
      }),
      this.prisma.client.rating.findMany({
        where: { userId: targetId },
        select: { albumId: true },
      }),
    ]);

    const resolved = new Set<string>(
      [...listens, ...ratings].map((row) => row.albumId),
    );

    return (rows as unknown as WantRow[])
      .filter((row) => !resolved.has(row.albumId))
      .map((row) => ({
        id: row.id,
        albumId: row.albumId,
        createdAt: row.createdAt.toISOString(),
        album: {
          id: row.album.id,
          title: row.album.title,
          coverUrl: row.album.coverUrl,
          primaryArtistName: row.album.primaryArtist.name,
        },
      }));
  }

  /** Validates the `albumId` (body or path) as a UUID (clean 400). */
  private validateAlbumId(value: unknown): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException("albumId must be a valid id.");
  }

  /**
   * Resolves the caller's local `User.id`, throwing 404 when no local row exists
   * yet (write paths require a synced account — same convention as the tracking
   * and lists modules' write flows).
   */
  private async requireCallerId(clerkUserId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException("No local account for the current user.");
    }
    return user.id;
  }

  /**
   * Resolves the target user's local `User.id` from a `username`, throwing 404
   * when no profile matches. Usernames are canonicalized to lowercase, matching
   * the profile module's storage convention.
   */
  private async requireTargetId(username: string): Promise<string> {
    const profile = await this.prisma.client.profile.findUnique({
      where: { username: username.trim().toLowerCase() },
      select: { userId: true },
    });
    if (!profile) {
      throw new NotFoundException(`No user found for username ${username}.`);
    }
    return profile.userId;
  }
}

/** Row shape returned by the {@link WantToListenService.getUserWantToListen} select. */
interface WantRow {
  id: string;
  albumId: string;
  createdAt: Date;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtist: { name: string };
  };
}
