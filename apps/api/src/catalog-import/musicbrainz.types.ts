/**
 * MusicBrainz Web Service v2 response shapes (narrowed to the fields the
 * enrichment leg uses) and the normalized enrichment the pipeline consumes.
 *
 * As with the Spotify types, only the subset of each MusicBrainz payload the
 * enricher actually reads is typed here — MusicBrainz returns far more per
 * object, but pinning the whole schema would be brittle for a leg that projects
 * an mbid, an artist mbid, and a handful of genre tags.
 */

/** A MusicBrainz artist reference embedded in an `artist-credit` entry. */
export interface MusicBrainzArtist {
  id: string;
  name: string;
}

/** One entry of a release-group's `artist-credit` array. */
export interface MusicBrainzArtistCredit {
  name?: string;
  artist?: MusicBrainzArtist;
}

/**
 * A MusicBrainz genre or folksonomy tag. Both `genres` and `tags` share this
 * `{ name, count }` shape in the WS/2 JSON; `count` is the community vote weight.
 */
export interface MusicBrainzTag {
  name: string;
  count?: number;
}

/** A MusicBrainz release-group (the album-level entity the enricher matches on). */
export interface MusicBrainzReleaseGroup {
  id: string;
  title?: string;
  /** MusicBrainz search relevance score (0-100) for the query. */
  score?: number;
  "artist-credit"?: MusicBrainzArtistCredit[];
  /** Curated genres (present when the entity has them). */
  genres?: MusicBrainzTag[];
  /** Folksonomy tags — the fallback when no curated `genres` exist. */
  tags?: MusicBrainzTag[];
}

/** The `/ws/2/release-group` search envelope. */
export interface MusicBrainzReleaseGroupSearch {
  count?: number;
  "release-groups"?: MusicBrainzReleaseGroup[];
}

/** A genre normalized from a MusicBrainz genre/tag for the `AlbumGenre` upsert. */
export interface NormalizedGenre {
  /** Stable lookup key (lowercased, hyphenated) — unique on `Genre.slug`. */
  slug: string;
  /** Human-facing display name. */
  name: string;
  /** Relative weight projected onto `AlbumGenre.weight` (from the vote count). */
  weight: number;
}

/**
 * MusicBrainz enrichment for a single album, normalized from the top matching
 * release-group into exactly what the Prisma enrichment upsert needs.
 */
export interface MusicBrainzEnrichment {
  /** Release-group mbid → `Album.mbid`. */
  mbid: string;
  /** Primary artist mbid + name → `Artist.mbid` (matched by the seeded row). */
  artist: { mbid: string; name: string } | null;
  /** Genres/tags → `Genre` + `AlbumGenre` rows. */
  genres: NormalizedGenre[];
}
