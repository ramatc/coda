import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { GenreSeed } from "./onboarding.constants.js";
import {
  OnboardingService,
  type AlbumSearchResult,
  type ArtistSearchResult,
  type CompleteOnboardingInput,
  type OnboardingStatus,
} from "./onboarding.service.js";

/**
 * Onboarding endpoints, all behind the global {@link ClerkGuard}. The multi-step
 * web wizard reads the genre taxonomy and searches the catalog through these
 * routes, then submits the full selection to `POST /onboarding/complete`; the
 * web onboarding gate polls `GET /onboarding/status`.
 */
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /** The current user's onboarding progress (drives the `/onboarding` gate). */
  @Get("status")
  getStatus(
    @CurrentUser("sub") clerkUserId: string,
  ): Promise<OnboardingStatus> {
    return this.onboarding.getStatus(clerkUserId);
  }

  /** The fixed genre taxonomy for the genre picker. */
  @Get("genres")
  getGenres(): readonly GenreSeed[] {
    return this.onboarding.listGenres();
  }

  /** Catalog artist search for the artist picker (empty until catalog import). */
  @Get("artists")
  searchArtists(
    @Query("q") query: unknown = "",
  ): Promise<ArtistSearchResult[]> {
    return this.onboarding.searchArtists(this.normalizeQuery(query));
  }

  /** Catalog album search for the optional album picker (empty until import). */
  @Get("albums")
  searchAlbums(
    @Query("q") query: unknown = "",
  ): Promise<AlbumSearchResult[]> {
    return this.onboarding.searchAlbums(this.normalizeQuery(query));
  }

  /**
   * Genre-based artist suggestions for a "browse by genre" picker step, e.g.
   * `GET /onboarding/artists/suggested?genres=rock,jazz`. Unknown genre slugs
   * are dropped, not rejected — see {@link OnboardingService.suggestArtists}.
   */
  @Get("artists/suggested")
  suggestArtists(
    @Query("genres") genres: unknown = "",
  ): Promise<ArtistSearchResult[]> {
    return this.onboarding.suggestArtists(this.parseGenreSlugsQuery(genres));
  }

  /**
   * Genre-based album suggestions, e.g.
   * `GET /onboarding/albums/suggested?genres=rock,jazz`. Same validation
   * posture as {@link suggestArtists}.
   */
  @Get("albums/suggested")
  suggestAlbums(
    @Query("genres") genres: unknown = "",
  ): Promise<AlbumSearchResult[]> {
    return this.onboarding.suggestAlbums(this.parseGenreSlugsQuery(genres));
  }

  /**
   * Persists the selection and returns the resulting (complete) status.
   * `200`, not Nest's default `201`: this is an idempotent "replace my
   * preferences" operation, not a resource creation.
   */
  @Post("complete")
  @HttpCode(200)
  complete(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: CompleteOnboardingInput,
  ): Promise<OnboardingStatus> {
    return this.onboarding.complete(clerkUserId, body);
  }

  /**
   * Express parses a repeated `?q=` query param as `string[]`, not `string`.
   * Coerces to a single string (first occurrence) so `query.trim()` in
   * {@link OnboardingService} never throws a `TypeError` on an array.
   */
  private normalizeQuery(value: unknown): string {
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === "string" ? first : "";
    }
    return typeof value === "string" ? value : "";
  }

  /**
   * Parses a comma-separated `?genres=` query param into a raw slug list,
   * reusing {@link normalizeQuery} for the same repeated-`?genres=`-param
   * coercion `?q=` gets. Slug validity (known vs. unknown) is checked in
   * {@link OnboardingService}, not here — this method only splits the string.
   */
  private parseGenreSlugsQuery(value: unknown): string[] {
    const raw = this.normalizeQuery(value);
    return raw
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0);
  }
}
