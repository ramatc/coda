import { Controller, Get, Query } from "@nestjs/common";
import {
  SearchService,
  type PopularAlbum,
  type SearchResults,
} from "./search.service.js";
import { Public } from "../auth/public.decorator.js";

/**
 * Read-only search endpoints, behind the global {@link ClerkGuard}. The discover
 * web page server-renders `GET /search/popular` for its initial view and calls
 * `GET /search?q=` from its as-you-type client island.
 *
 * `GET /search` rejects an empty/whitespace query with a 400 (handled in
 * {@link SearchService.search}) and never triggers a catalog import on a miss —
 * Fase 1 has no on-demand import.
 *
 * `@Public()` is applied at METHOD level only, never on this class. The public
 * landing page reads `GET /search/popular` with no session, but `GET /search` is
 * a Meilisearch-backed query that stays behind the guard. `ClerkGuard` resolves
 * the flag with `getAllAndOverride([handler, class])`, so a class-level
 * `@Public()` would silently exempt `GET /search` and every route added here
 * later. `search.controller.spec.ts` pins that placement.
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

  /**
   * Popular albums for the discover landing view (server-rendered initial data)
   * and for the anonymous public landing page — hence `@Public()`. Nothing in
   * {@link PopularAlbum} depends on the viewer, so no `OptionalClerkGuard` is
   * needed to resolve a caller here.
   */
  @Public()
  @Get("popular")
  popular(@Query("limit") limit?: unknown): Promise<PopularAlbum[]> {
    return this.search.popularAlbums(limit);
  }
}
