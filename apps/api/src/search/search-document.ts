/**
 * Meilisearch document shapes and the pure Postgres-row → document mappers.
 *
 * Kept free of Prisma/Nest so the mapping is trivially unit-testable and so the
 * exact indexed shape is documented in one place. The Prisma `select` shapes in
 * {@link SearchSyncService} are the inputs these mappers consume.
 */

/** An album row as read from Postgres for indexing. */
export interface AlbumRow {
  id: string;
  spotifyId: string | null;
  mbid: string | null;
  title: string;
  releaseDate: Date | null;
  coverUrl: string | null;
  popularityScore: number;
  primaryArtist: { name: string };
  genres: { genre: { slug: string; name: string } }[];
}

/** An artist row as read from Postgres for indexing. */
export interface ArtistRow {
  id: string;
  spotifyId: string | null;
  mbid: string | null;
  name: string;
  imageUrl: string | null;
}

/** Album document stored in the Meilisearch `albums` index (pk `id`). */
export interface AlbumSearchDocument {
  id: string;
  spotifyId: string | null;
  mbid: string | null;
  title: string;
  primaryArtistName: string;
  genreNames: string[];
  genreSlugs: string[];
  releaseYear: number | null;
  coverUrl: string | null;
  popularityScore: number;
}

/** Artist document stored in the Meilisearch `artists` index (pk `id`). */
export interface ArtistSearchDocument {
  id: string;
  spotifyId: string | null;
  mbid: string | null;
  name: string;
  imageUrl: string | null;
}

/** Maps an album row (with its primary artist + genres) to its search document. */
export function toAlbumDocument(album: AlbumRow): AlbumSearchDocument {
  return {
    id: album.id,
    spotifyId: album.spotifyId,
    mbid: album.mbid,
    title: album.title,
    primaryArtistName: album.primaryArtist.name,
    genreNames: album.genres.map((g) => g.genre.name),
    genreSlugs: album.genres.map((g) => g.genre.slug),
    releaseYear: album.releaseDate ? album.releaseDate.getUTCFullYear() : null,
    coverUrl: album.coverUrl,
    popularityScore: album.popularityScore,
  };
}

/** Maps an artist row to its search document. */
export function toArtistDocument(artist: ArtistRow): ArtistSearchDocument {
  return {
    id: artist.id,
    spotifyId: artist.spotifyId,
    mbid: artist.mbid,
    name: artist.name,
    imageUrl: artist.imageUrl,
  };
}
