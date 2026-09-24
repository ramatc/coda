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

/**
 * A genre in the fixed onboarding taxonomy.
 *
 * `category` is a purely editorial grouping label (NOT the `Genre.parentGenreId`
 * self-relation in the Prisma schema, which is unused and untouched here) — it
 * exists only to let the genre picker render genres in sensible sections.
 * `descriptor` is a short, human-facing subtitle for the genre tile.
 */
export interface GenreSeed {
  slug: string;
  name: string;
  category: string;
  descriptor: string;
}

/**
 * The fixed genre taxonomy offered during onboarding. Ordered for stable
 * rendering; `slug` is the canonical key (unique in the `Genre` table) used to
 * upsert the row on submit. `category`/`descriptor` are editorial content for
 * the picker UI only and are never persisted or validated against the DB.
 */
export const GENRE_CATALOG: readonly GenreSeed[] = [
  {
    slug: "rock",
    name: "Rock",
    category: "Rock & Punk",
    descriptor: "Guitar-driven, riff-heavy, arena to garage",
  },
  {
    slug: "pop",
    name: "Pop",
    category: "Pop & Global",
    descriptor: "Hook-driven, polished, chart-focused mainstream",
  },
  {
    slug: "hip-hop",
    name: "Hip-Hop",
    category: "Hip-Hop & R&B",
    descriptor: "Boom bap, lyrical, East Coast, underground",
  },
  {
    slug: "r-n-b",
    name: "R&B",
    category: "Hip-Hop & R&B",
    descriptor: "Smooth vocals, groove-based, contemporary soul",
  },
  {
    slug: "soul",
    name: "Soul",
    category: "Hip-Hop & R&B",
    descriptor: "Gospel-rooted, emotive, Motown & Southern",
  },
  {
    slug: "funk",
    name: "Funk",
    category: "Hip-Hop & R&B",
    descriptor: "Syncopated bass, horn-driven, groove-first",
  },
  {
    slug: "jazz",
    name: "Jazz",
    category: "Jazz & Blues",
    descriptor: "Modal, spiritual, fusion & hard bop",
  },
  {
    slug: "blues",
    name: "Blues",
    category: "Jazz & Blues",
    descriptor: "12-bar, guitar-led, Delta & Chicago",
  },
  {
    slug: "electronic",
    name: "Electronic",
    category: "Electronic & Ambient",
    descriptor: "Synth-driven, dance floor, house & techno",
  },
  {
    slug: "ambient",
    name: "Ambient",
    category: "Electronic & Ambient",
    descriptor: "Atmospheric, textural, slow-evolving soundscapes",
  },
  {
    slug: "classical",
    name: "Classical",
    category: "Classical & Folk",
    descriptor: "Orchestral, composed, Baroque to Romantic",
  },
  {
    slug: "folk",
    name: "Folk",
    category: "Classical & Folk",
    descriptor: "Acoustic, storytelling, traditional & singer-songwriter",
  },
  {
    slug: "country",
    name: "Country",
    category: "Classical & Folk",
    descriptor: "Twangy, narrative, Nashville & outlaw",
  },
  {
    slug: "metal",
    name: "Metal",
    category: "Rock & Punk",
    descriptor: "Distorted, heavy, thrash to doom",
  },
  {
    slug: "punk",
    name: "Punk",
    category: "Rock & Punk",
    descriptor: "Raw, fast, DIY & anti-establishment",
  },
  {
    slug: "indie",
    name: "Indie",
    category: "Rock & Punk",
    descriptor: "Lo-fi, independent, jangly guitar pop",
  },
  {
    slug: "reggae",
    name: "Reggae",
    category: "Pop & Global",
    descriptor: "Offbeat skank, bass-heavy, Jamaican roots",
  },
  {
    slug: "latin",
    name: "Latin",
    category: "Pop & Global",
    descriptor: "Rhythmic, percussive, salsa to reggaeton",
  },
] as const;

/** Fast lookup of a genre by slug, so a submitted slug can be validated + named. */
export const GENRE_CATALOG_BY_SLUG: ReadonlyMap<string, GenreSeed> = new Map(
  GENRE_CATALOG.map((genre) => [genre.slug, genre]),
);

/** Upper bound on a search-result page for the artist/album pickers. */
export const SEARCH_RESULT_LIMIT = 20;
