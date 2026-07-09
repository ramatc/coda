import { Body, Controller, Get, Post, Query } from "@nestjs/common";
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
    @Query("q") query = "",
  ): Promise<ArtistSearchResult[]> {
    return this.onboarding.searchArtists(query);
  }

  /** Catalog album search for the optional album picker (empty until import). */
  @Get("albums")
  searchAlbums(
    @Query("q") query = "",
  ): Promise<AlbumSearchResult[]> {
    return this.onboarding.searchAlbums(query);
  }

  /** Persists the selection and returns the resulting (complete) status. */
  @Post("complete")
  complete(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: CompleteOnboardingInput,
  ): Promise<OnboardingStatus> {
    return this.onboarding.complete(clerkUserId, body);
  }
}
