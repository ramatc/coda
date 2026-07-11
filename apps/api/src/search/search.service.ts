import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { MeiliService } from "./meili.service.js";
import {
  DEFAULT_POPULAR_LIMIT,
  DEFAULT_SEARCH_PAGE_SIZE,
  MAX_SEARCH_PAGE_SIZE,
} from "./search.constants.js";
import type {
  AlbumSearchDocument,
  ArtistSearchDocument,
} from "./search-document.js";

/** A ranked search response for `GET /search`. */
export interface SearchResults {
  query: string;
  page: number;
  limit: number;
  albums: AlbumSearchDocument[];
  artists: ArtistSearchDocument[];
  totalAlbums: number;
  totalArtists: number;
}

/** A popular-album card for the discover landing view. */
export interface PopularAlbum {
  id: string;
  title: string;
  coverUrl: string | null;
  primaryArtistName: string;
}

/**
 * Read side of search (PR7). Owns the two query paths the discover page uses:
 *
 *  - {@link search}: the ranked, paginated album/artist query backed by
 *    Meilisearch. It validates the query string BEFORE touching Meili — an empty
 *    or whitespace-only query is rejected with a 400 and NO Meili call is made
 *    (spec "Empty query is rejected"). Crucially, a query that matches nothing
 *    returns empty results and does NOT enqueue any catalog-import job — there is
 *    no on-demand/lazy import in Fase 1 (spec "No On-Demand Import"), which is
 *    structurally guaranteed here: this service depends only on {@link MeiliService}
 *    and {@link PrismaService}, never on the catalog-import queue.
 *  - {@link popularAlbums}: the server-rendered initial "popular" list, a simple
 *    top-by-`popularityScore` read straight from Postgres (the source of truth) —
 *    deliberately a plain heuristic, not a ranking model.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meili: MeiliService,
  ) {}

  /**
   * Ranked album/artist search. Throws {@link BadRequestException} for an empty
   * or whitespace-only query WITHOUT calling Meilisearch. `page` is 1-based;
   * `page`/`limit` are clamped to sane bounds rather than rejected.
   */
  async search(
    rawQuery: unknown,
    rawPage?: unknown,
    rawLimit?: unknown,
  ): Promise<SearchResults> {
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (query.length === 0) {
      throw new BadRequestException("Search query must not be empty.");
    }

    const page = this.clampPage(rawPage);
    const limit = this.clampLimit(rawLimit);
    const offset = (page - 1) * limit;

    const [albums, artists] = await Promise.all([
      this.meili.searchAlbums(query, { limit, offset }),
      this.meili.searchArtists(query, { limit, offset }),
    ]);

    return {
      query,
      page,
      limit,
      albums: albums.hits,
      artists: artists.hits,
      totalAlbums: albums.estimatedTotalHits,
      totalArtists: artists.estimatedTotalHits,
    };
  }

  /**
   * The initial "popular" albums for the discover landing view: the highest
   * `popularityScore` albums straight from Postgres. A simple, explainable
   * heuristic (top-N by the Spotify-seeded popularity), not a ranking algorithm.
   */
  async popularAlbums(
    rawLimit?: unknown,
    limitFallback: number = DEFAULT_POPULAR_LIMIT,
  ): Promise<PopularAlbum[]> {
    const limit = this.clampLimit(rawLimit, limitFallback);
    const albums = await this.prisma.client.album.findMany({
      select: {
        id: true,
        title: true,
        coverUrl: true,
        primaryArtist: { select: { name: true } },
      },
      orderBy: { popularityScore: "desc" },
      take: limit,
    });
    return albums.map((album) => ({
      id: album.id,
      title: album.title,
      coverUrl: album.coverUrl,
      primaryArtistName: album.primaryArtist.name,
    }));
  }

  private clampPage(value: unknown): number {
    const page = this.toInt(value);
    return page !== null && page >= 1 ? page : 1;
  }

  private clampLimit(
    value: unknown,
    fallback: number = DEFAULT_SEARCH_PAGE_SIZE,
  ): number {
    const limit = this.toInt(value);
    if (limit === null || limit < 1) {
      return fallback;
    }
    return Math.min(limit, MAX_SEARCH_PAGE_SIZE);
  }

  /** Parses a query-string number (Express passes strings), else `null`. */
  private toInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value, 10);
    }
    return null;
  }
}
