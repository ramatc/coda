import { getApiBaseUrl } from "./api-client";

/** An album hit from `GET /search` (mirrors the API's `AlbumSearchDocument`). */
export interface AlbumSearchResult {
  id: string;
  title: string;
  primaryArtistName: string;
  coverUrl: string | null;
  releaseYear: number | null;
}

/** An artist hit from `GET /search`. */
export interface ArtistSearchResult {
  id: string;
  name: string;
  imageUrl: string | null;
}

/** The ranked search response shape from `GET /search`. */
export interface SearchResults {
  query: string;
  page: number;
  limit: number;
  albums: AlbumSearchResult[];
  artists: ArtistSearchResult[];
  totalAlbums: number;
  totalArtists: number;
}

/** A popular-album card from `GET /search/popular` (discover landing view). */
export interface PopularAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/** Route to an album's detail page (`apps/web/app/albums/[id]`, built in PR9). */
export function albumHref(id: string): string {
  return `/albums/${id}`;
}

/**
 * Fetches the initial "popular" albums for the discover page, server-side, with
 * the user's Clerk token. A network failure or non-OK response fails safe to an
 * empty list rather than throwing during render (same posture as
 * `lib/onboarding.ts`'s `fetchGenres`).
 */
export async function fetchPopularAlbums(
  token: string | null,
): Promise<PopularAlbum[]> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/search/popular`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return [];
    }
    return (await response.json()) as PopularAlbum[];
  } catch {
    return [];
  }
}

/**
 * Runs a catalog search from the client (the as-you-type island). Returns `null`
 * on a failed/aborted request so the caller can keep the current results on
 * screen instead of clearing them. An empty/whitespace query is treated as "no
 * search" (`null`) and never hits the API — the API would 400 it anyway.
 */
export async function searchCatalog(
  token: string | null,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResults | null> {
  const q = query.trim();
  if (q.length === 0) {
    return null;
  }
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/search?q=${encodeURIComponent(q)}`,
      {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        signal,
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as SearchResults;
  } catch {
    return null;
  }
}
