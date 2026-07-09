import { getApiBaseUrl } from "./api-client";

/** Onboarding progress as returned by the API's `GET /onboarding/status`. */
export interface OnboardingStatus {
  complete: boolean;
  genreCount: number;
  artistCount: number;
  albumCount: number;
}

/** A genre offered by the picker (`GET /onboarding/genres`). */
export interface GenreOption {
  slug: string;
  name: string;
}

/** An artist search result (`GET /onboarding/artists`). */
export interface ArtistOption {
  id: string;
  name: string;
  imageUrl: string | null;
}

/** An album search result (`GET /onboarding/albums`). */
export interface AlbumOption {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** Capture minimums mirrored from the API for client-side step gating. */
export const MIN_GENRES = 3;
export const MIN_ARTISTS = 1;
export const MAX_ALBUMS = 4;

/** Where the onboarding gate sends an incomplete user. */
export const ONBOARDING_PATH = "/onboarding";
/** Where a completed onboarding lands. */
export const HOME_PATH = "/home";

/**
 * Pure onboarding-gate decision, extracted so it is unit-testable without a
 * request context (same pattern as `cors.config.ts` / `middleware.config.ts`).
 *
 * Returns the path to redirect to, or `null` to allow the request through:
 * - an incomplete user on any gated app route → `/onboarding`;
 * - a user who is ALREADY complete but sitting on `/onboarding` → `/home`
 *   (so they don't get stuck re-onboarding);
 * - otherwise → `null`.
 */
export function resolveOnboardingRedirect(
  status: Pick<OnboardingStatus, "complete">,
  currentPath: string,
): string | null {
  const onOnboarding = currentPath.startsWith(ONBOARDING_PATH);
  if (!status.complete && !onOnboarding) {
    return ONBOARDING_PATH;
  }
  if (status.complete && onOnboarding) {
    return HOME_PATH;
  }
  return null;
}

/** True once the selection satisfies the API's completion rules. */
export function isOnboardingSubmittable(
  genreCount: number,
  artistCount: number,
  albumCount: number,
): boolean {
  return (
    genreCount >= MIN_GENRES &&
    artistCount >= MIN_ARTISTS &&
    albumCount <= MAX_ALBUMS
  );
}

/**
 * Fetches the current user's onboarding status from the API with their Clerk
 * token. A non-OK response is treated as "not complete" so the gate fails
 * safe (an unverifiable session is sent to onboarding, never past it).
 */
export async function fetchOnboardingStatus(
  token: string | null,
): Promise<OnboardingStatus> {
  const fallback: OnboardingStatus = {
    complete: false,
    genreCount: 0,
    artistCount: 0,
    albumCount: 0,
  };
  try {
    const response = await fetch(`${getApiBaseUrl()}/onboarding/status`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return fallback;
    }
    return (await response.json()) as OnboardingStatus;
  } catch {
    return fallback;
  }
}

/** Fetches the fixed genre taxonomy for the picker. */
export async function fetchGenres(token: string | null): Promise<GenreOption[]> {
  const response = await fetch(`${getApiBaseUrl()}/onboarding/genres`, {
    headers: { Authorization: `Bearer ${token ?? ""}` },
    cache: "no-store",
  });
  if (!response.ok) {
    return [];
  }
  return (await response.json()) as GenreOption[];
}
