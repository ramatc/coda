import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  GENRE_CATALOG,
  GENRE_CATALOG_BY_SLUG,
  MAX_ALBUMS,
  MAX_ARTISTS,
  MIN_ARTISTS,
  MIN_GENRES,
  SEARCH_RESULT_LIMIT,
  UUID_PATTERN,
  type GenreSeed,
} from "./onboarding.constants.js";

export interface OnboardingStatus {
  /**
   * Derived, not stored: onboarding is complete once the user has persisted at
   * least {@link MIN_GENRES} genre preferences and {@link MIN_ARTISTS} artist
   * favorites. No `onboardedAt` column exists (PR1's migration is frozen), so
   * completion is computed from the preference rows themselves.
   */
  complete: boolean;
  genreCount: number;
  artistCount: number;
  albumCount: number;
}

export interface ArtistSearchResult {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface AlbumSearchResult {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

export interface CompleteOnboardingInput {
  genreSlugs?: unknown;
  artistIds?: unknown;
  albumIds?: unknown;
}

/**
 * Captures a new user's music preferences (genres, favorite artists, optional
 * favorite albums) and answers the onboarding-complete gate. Runs behind the
 * global `ClerkGuard`; the controller passes the verified Clerk user id, which
 * this service maps to the local `User.id` (the FK all preference rows use).
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The fixed genre taxonomy offered by the onboarding genre picker. */
  listGenres(): readonly GenreSeed[] {
    return GENRE_CATALOG;
  }

  /**
   * Searches the imported catalog for artists to favorite. Until the catalog
   * import lands (PR5/PR6) the `Artist` table is empty, so this returns `[]`
   * gracefully rather than erroring — the picker shows an empty state.
   */
  async searchArtists(query: string): Promise<ArtistSearchResult[]> {
    const q = query.trim();
    if (q.length === 0) {
      return [];
    }
    const artists = await this.prisma.client.artist.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      select: { id: true, name: true, imageUrl: true },
      orderBy: { name: "asc" },
      take: SEARCH_RESULT_LIMIT,
    });
    return artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      imageUrl: artist.imageUrl,
    }));
  }

  /**
   * Searches the imported catalog for albums to favorite. Empty until catalog
   * import lands (PR5/PR6); returns `[]` gracefully in the meantime.
   */
  async searchAlbums(query: string): Promise<AlbumSearchResult[]> {
    const q = query.trim();
    if (q.length === 0) {
      return [];
    }
    const albums = await this.prisma.client.album.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      select: {
        id: true,
        title: true,
        coverUrl: true,
        primaryArtist: { select: { name: true } },
      },
      orderBy: { popularityScore: "desc" },
      take: SEARCH_RESULT_LIMIT,
    });
    return albums.map((album) => ({
      id: album.id,
      title: album.title,
      coverUrl: album.coverUrl,
      primaryArtistName: album.primaryArtist.name,
    }));
  }

  /** The current user's onboarding progress (drives the `/onboarding` gate). */
  async getStatus(clerkUserId: string): Promise<OnboardingStatus> {
    const userId = await this.resolveUserId(clerkUserId);
    return this.getStatusByUserId(userId);
  }

  /**
   * Same as {@link getStatus}, but takes an already-resolved local `User.id`
   * so callers that have already paid for the `resolveUserId` lookup (e.g.
   * {@link complete}) don't re-resolve the user from `clerkUserId` a second
   * time.
   */
  private async getStatusByUserId(userId: string): Promise<OnboardingStatus> {
    const [genreCount, artistCount, albumCount] = await Promise.all([
      this.prisma.client.userGenrePreference.count({ where: { userId } }),
      this.prisma.client.userArtistFavorite.count({ where: { userId } }),
      this.prisma.client.userAlbumFavorite.count({ where: { userId } }),
    ]);
    return {
      complete: genreCount >= MIN_GENRES && artistCount >= MIN_ARTISTS,
      genreCount,
      artistCount,
      albumCount,
    };
  }

  /**
   * Persists the user's onboarding selections and returns the resulting status.
   *
   * Validation (spec): at least {@link MIN_GENRES} genres and {@link MIN_ARTISTS}
   * (up to {@link MAX_ARTISTS}) artists are REQUIRED; up to {@link MAX_ALBUMS}
   * albums are OPTIONAL. A failing count throws `BadRequestException` and
   * writes nothing.
   *
   * The whole write runs in one transaction and is idempotent/re-runnable:
   * prior preferences for the user are cleared and rewritten, so submitting the
   * form twice (or editing selections) yields a clean "set my preferences"
   * result rather than duplicate-key errors on the composite PKs. A P2002 from
   * a concurrent/overlapping submission (composite PKs on the preference
   * tables) is caught and surfaced as a clean, retryable `ConflictException`
   * rather than an unhandled 500.
   */
  async complete(
    clerkUserId: string,
    input: CompleteOnboardingInput,
  ): Promise<OnboardingStatus> {
    const userId = await this.resolveUserId(clerkUserId);

    const genreSlugs = this.parseGenreSlugs(input.genreSlugs);
    const artistIds = this.parseIdList(input.artistIds, "artistIds", MAX_ARTISTS);
    const albumIds = this.parseIdList(input.albumIds, "albumIds", MAX_ALBUMS);

    if (genreSlugs.length < MIN_GENRES) {
      throw new BadRequestException(
        `Select at least ${MIN_GENRES} genres to complete onboarding.`,
      );
    }
    if (artistIds.length < MIN_ARTISTS) {
      throw new BadRequestException(
        `Select at least ${MIN_ARTISTS} favorite artist(s) to complete onboarding.`,
      );
    }
    // `parseIdList` above already guarantees `artistIds`/`albumIds` are
    // deduplicated arrays no longer than MAX_ARTISTS/MAX_ALBUMS respectively
    // (it throws before returning otherwise), so re-checking `.length` here
    // would be unreachable dead code — the cap is enforced once, at parse time.

    try {
      await this.prisma.client.$transaction(async (tx) => {
        // Genres come from the fixed taxonomy: upsert each by its unique slug so
        // the FK resolves even on an empty catalog. Validated against the catalog
        // above, so `name` is always known.
        const genreIds: string[] = [];
        for (const slug of genreSlugs) {
          const seed = GENRE_CATALOG_BY_SLUG.get(slug) as GenreSeed;
          const genre = await tx.genre.upsert({
            where: { slug },
            create: { slug, name: seed.name },
            update: {},
            select: { id: true },
          });
          genreIds.push(genre.id);
        }

        // Artists/albums must reference real catalog rows. Verify existence before
        // writing so a stale or forged id surfaces as a 400, not an FK crash.
        await this.assertAllExist(
          tx.artist.findMany({
            where: { id: { in: artistIds } },
            select: { id: true },
          }),
          artistIds,
          "artist",
        );
        if (albumIds.length > 0) {
          await this.assertAllExist(
            tx.album.findMany({
              where: { id: { in: albumIds } },
              select: { id: true },
            }),
            albumIds,
            "album",
          );
        }

        await tx.userGenrePreference.deleteMany({ where: { userId } });
        await tx.userArtistFavorite.deleteMany({ where: { userId } });
        await tx.userAlbumFavorite.deleteMany({ where: { userId } });

        await tx.userGenrePreference.createMany({
          data: genreIds.map((genreId) => ({ userId, genreId })),
        });
        await tx.userArtistFavorite.createMany({
          data: artistIds.map((artistId, index) => ({
            userId,
            artistId,
            rank: index + 1,
          })),
        });
        if (albumIds.length > 0) {
          await tx.userAlbumFavorite.createMany({
            data: albumIds.map((albumId, index) => ({
              userId,
              albumId,
              rank: index + 1,
            })),
          });
        }
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const field = extractUniqueConstraintField(err);
        throw new ConflictException(
          field
            ? `Your onboarding preferences conflicted on ${field} with a concurrent update. Please retry.`
            : "Your onboarding preferences conflicted with a concurrent update. Please retry.",
        );
      }
      throw err;
    }

    return this.getStatusByUserId(userId);
  }

  /** Resolves the local `User.id` for a Clerk user id, or throws 404. */
  private async resolveUserId(clerkUserId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException("No user found for the current session");
    }
    return user.id;
  }

  private parseGenreSlugs(value: unknown): string[] {
    const slugs = this.parseStringArray(value, "genreSlugs");
    const unique = [...new Set(slugs)];
    for (const slug of unique) {
      if (!GENRE_CATALOG_BY_SLUG.has(slug)) {
        throw new BadRequestException(`Unknown genre: ${slug}`);
      }
    }
    return unique;
  }

  /**
   * Parses `artistIds`/`albumIds` and validates each entry is UUID-shaped
   * BEFORE it is used in a Prisma query. Without this, a malformed id (not a
   * UUID at all) reaches Postgres and is rejected with a raw "invalid input
   * syntax for type uuid" error — an unhandled 500, not the clean 400 this
   * service otherwise guarantees for a stale/forged id (see
   * {@link assertAllExist}).
   */
  private parseIdList(value: unknown, field: string, max: number): string[] {
    if (value === undefined || value === null) {
      return [];
    }
    // Reject an oversized array before the per-element trim/regex work below
    // runs on every element — no point paying that cost on input that will be
    // rejected anyway. The cap applies to the DEDUPLICATED id count (matching
    // what this method returns), so duplicates are stripped via `Set` before
    // comparing against `max` — a raw array with repeated ids (e.g. a client
    // retry that appends rather than replaces) must not be rejected just
    // because its raw length exceeds `max` while its unique id count does not.
    if (Array.isArray(value) && new Set(value).size > max) {
      throw new BadRequestException(`${field} must contain at most ${max} ids.`);
    }
    const ids = [...new Set(this.parseStringArray(value, field))];
    for (const id of ids) {
      if (!UUID_PATTERN.test(id)) {
        throw new BadRequestException(`${field} must contain valid ids.`);
      }
    }
    return ids;
  }

  private parseStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array of strings.`);
    }
    return value.map((item) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new BadRequestException(`${field} must be an array of strings.`);
      }
      return item.trim();
    });
  }

  private async assertAllExist(
    found: Promise<{ id: string }[]>,
    requested: string[],
    label: string,
  ): Promise<void> {
    const rows = await found;
    if (rows.length !== requested.length) {
      const known = new Set(rows.map((row) => row.id));
      const missing = requested.filter((id) => !known.has(id));
      throw new BadRequestException(
        `Unknown ${label}(s): ${missing.join(", ")}`,
      );
    }
  }
}
