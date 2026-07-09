/**
 * Onboarding capture rules and the fixed genre taxonomy.
 *
 * Genres are a small, curated reference taxonomy owned by onboarding — NOT part
 * of the Spotify/MusicBrainz catalog import (PR5/PR6), which brings artists and
 * albums. Serving genres from a fixed list here means onboarding's genre step
 * works end-to-end even before any catalog data exists: the {@link OnboardingService}
 * upserts each selected genre into the `Genre` table by its stable `slug` at
 * submit time, so the `UserGenrePreference` foreign key is always satisfiable.
 *
 * Artists and albums, by contrast, are searched from the (catalog-imported)
 * `Artist`/`Album` tables and cannot be served from a fixed list.
 */

/** Minimum genres a user MUST select to complete onboarding (spec: at least 3). */
export const MIN_GENRES = 3;

/** Minimum favorite artists a user MUST select (spec: at least 1). */
export const MIN_ARTISTS = 1;

/** Maximum favorite albums a user MAY select (spec: up to 4, optional). */
export const MAX_ALBUMS = 4;

/** A genre in the fixed onboarding taxonomy. */
export interface GenreSeed {
  slug: string;
  name: string;
}

/**
 * The fixed genre taxonomy offered during onboarding. Ordered for stable
 * rendering; `slug` is the canonical key (unique in the `Genre` table) used to
 * upsert the row on submit.
 */
export const GENRE_CATALOG: readonly GenreSeed[] = [
  { slug: "rock", name: "Rock" },
  { slug: "pop", name: "Pop" },
  { slug: "hip-hop", name: "Hip-Hop" },
  { slug: "r-n-b", name: "R&B" },
  { slug: "soul", name: "Soul" },
  { slug: "funk", name: "Funk" },
  { slug: "jazz", name: "Jazz" },
  { slug: "blues", name: "Blues" },
  { slug: "electronic", name: "Electronic" },
  { slug: "ambient", name: "Ambient" },
  { slug: "classical", name: "Classical" },
  { slug: "folk", name: "Folk" },
  { slug: "country", name: "Country" },
  { slug: "metal", name: "Metal" },
  { slug: "punk", name: "Punk" },
  { slug: "indie", name: "Indie" },
  { slug: "reggae", name: "Reggae" },
  { slug: "latin", name: "Latin" },
] as const;

/** Fast lookup of a genre by slug, so a submitted slug can be validated + named. */
export const GENRE_CATALOG_BY_SLUG: ReadonlyMap<string, GenreSeed> = new Map(
  GENRE_CATALOG.map((genre) => [genre.slug, genre]),
);

/** Upper bound on a search-result page for the artist/album pickers. */
export const SEARCH_RESULT_LIMIT = 20;
