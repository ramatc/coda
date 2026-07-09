import { MAX_ALBUMS, MAX_ARTISTS, MIN_ARTISTS, MIN_GENRES } from "@coda/types";

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
 *
 * The capture bounds themselves (`MIN_GENRES`/`MIN_ARTISTS`/`MAX_ARTISTS`/
 * `MAX_ALBUMS`) live in `@coda/types` so the API and the web wizard share a
 * single source of truth — re-exported here so existing call sites in this
 * module keep importing from `./onboarding.constants.js`.
 */
export { MIN_GENRES, MIN_ARTISTS, MAX_ARTISTS, MAX_ALBUMS };

/**
 * Matches a canonical UUID (any RFC 4122 version). `artistIds`/`albumIds` are
 * validated against this BEFORE they reach a Prisma query — an id shaped like
 * this but unknown to the catalog still surfaces as a clean 400 via
 * {@link OnboardingService.assertAllExist}, while a malformed id (not a UUID at
 * all) is rejected here rather than reaching Postgres, which would otherwise
 * reject it with a raw "invalid input syntax for type uuid" error.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
