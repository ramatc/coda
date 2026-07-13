import { getApiBaseUrl } from "./api-client";

/** Why an album was recommended (mirrors the API's `RecommendationReason`). */
export interface RecommendationReason {
  /** Name of the strongest matched genre, or `null`. */
  topGenre: string | null;
  /** Whether the album's primary artist is one the user favors. */
  matchedArtist: boolean;
}

/** The album a recommendation points at (mirrors the API's `RecommendationAlbum`). */
export interface RecommendationAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseYear: number | null;
  primaryArtistName: string;
}

/** One surfaced recommendation (mirrors the API's `RecommendationItem`). */
export interface Recommendation {
  id: string;
  score: number;
  reason: RecommendationReason;
  album: RecommendationAlbum;
}

/**
 * Fetches the viewer's recommendations for `/home`, server-side, with their
 * Clerk token. A network failure or non-OK response fails safe to an empty list
 * rather than throwing during render (same posture as `fetchPopularAlbums`): the
 * home page still renders its shell + an empty state, and recommendations
 * populate on the next visit once generation has run.
 */
export async function fetchRecommendations(
  token: string | null,
): Promise<Recommendation[]> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/recommendations`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as Recommendation[];
  } catch {
    return [];
  }
}

/**
 * Dismisses a recommendation from the client (the dismiss button island). Throws
 * on a non-OK response so the island can surface an error and NOT optimistically
 * remove the card. `POST /recommendations/:id/dismiss` is idempotent server-side
 * (re-dismissing an already-dismissed row is a no-op success).
 */
export async function dismissRecommendation(
  token: string | null,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/recommendations/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}` },
    },
  );
  if (!response.ok) {
    throw new Error("Could not dismiss this recommendation.");
  }
}
