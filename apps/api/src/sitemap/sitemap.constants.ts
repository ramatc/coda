/**
 * Caps for `GET /sitemap`. The sitemap protocol allows at most 50,000 URLs in
 * one file, and the web app adds its static pages on top, so the two caps sum
 * to less than that. When the catalog outgrows them the feed needs paging into
 * a sitemap index; until then the most popular albums and the most recently
 * updated public lists are the ones kept.
 */
export const SITEMAP_MAX_ALBUMS = 40_000;
export const SITEMAP_MAX_LISTS = 9_000;
