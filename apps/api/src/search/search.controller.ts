import { Controller, Get, Query } from "@nestjs/common";
import {
  SearchService,
  type PopularAlbum,
  type SearchResults,
} from "./search.service.js";

/**
 * Read-only search endpoints, behind the global {@link ClerkGuard}. The discover
 * web page server-renders `GET /search/popular` for its initial view and calls
 * `GET /search?q=` from its as-you-type client island.
 *
 * `GET /search` rejects an empty/whitespace query with a 400 (handled in
 * {@link SearchService.search}) and never triggers a catalog import on a miss —
 * Fase 1 has no on-demand import.
 */
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** Ranked, paginated album/artist search. Empty query → 400 (no Meili call). */
  @Get()
  query(
    @Query("q") q?: unknown,
    @Query("page") page?: unknown,
    @Query("limit") limit?: unknown,
  ): Promise<SearchResults> {
    return this.search.search(q, page, limit);
  }

  /** Popular albums for the discover landing view (server-rendered initial data). */
  @Get("popular")
  popular(@Query("limit") limit?: unknown): Promise<PopularAlbum[]> {
    return this.search.popularAlbums(limit);
  }
}
