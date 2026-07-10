/**
 * Spotify Web API response shapes (narrowed to the fields the seed uses) and the
 * normalized album the rest of the pipeline consumes.
 *
 * Only the subset of each Spotify payload the importer actually reads is typed
 * here — Spotify returns far more per object, but pinning the whole schema would
 * be brittle and pointless for a seed that projects a handful of columns.
 */

/** Client-credentials token response from `POST /api/token`. */
export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  /** Lifetime in seconds (Spotify returns 3600). */
  expires_in: number;
}

/** A Spotify image (cover/artist art); `url` is the only field the seed keeps. */
export interface SpotifyImage {
  url: string;
  height?: number | null;
  width?: number | null;
}

/** A Spotify simplified-artist object as embedded on an album. */
export interface SpotifyArtistRef {
  id: string;
  name: string;
  images?: SpotifyImage[];
}

/** A Spotify album object (from browse/new-releases or search). */
export interface SpotifyAlbum {
  id: string;
  name: string;
  release_date?: string | null;
  /** Spotify precision: `year` | `month` | `day` — governs how to parse `release_date`. */
  release_date_precision?: "year" | "month" | "day" | null;
  images?: SpotifyImage[];
  artists?: SpotifyArtistRef[];
  total_tracks?: number | null;
  popularity?: number | null;
}

/** The paginated album envelope Spotify wraps browse/search results in. */
export interface SpotifyAlbumPage {
  items: SpotifyAlbum[];
  total: number;
  limit: number;
  offset: number;
  /** Absolute URL of the next page, or `null` on the last page. */
  next: string | null;
}

/**
 * A catalog album normalized from Spotify into exactly what the Prisma upsert
 * needs — decoupling the persistence layer from Spotify's wire format. The
 * MusicBrainz enrichment leg (PR6) later augments these rows keyed by `mbid`.
 */
export interface NormalizedAlbum {
  spotifyId: string;
  title: string;
  /** ISO `yyyy-mm-dd` (padded from partial Spotify precision), or null. */
  releaseDate: string | null;
  coverUrl: string | null;
  trackCount: number | null;
  /** Spotify popularity 0-100, projected onto `Album.popularityScore`. */
  popularityScore: number;
  primaryArtist: NormalizedArtist;
}

/** A catalog artist normalized from Spotify's embedded primary artist. */
export interface NormalizedArtist {
  spotifyId: string;
  name: string;
  imageUrl: string | null;
}

/** One fetched page of normalized albums plus the cursor to the next page. */
export interface NormalizedAlbumPage {
  albums: NormalizedAlbum[];
  /** Offset to fetch next, or `null` when this was the final page. */
  nextOffset: number | null;
}
