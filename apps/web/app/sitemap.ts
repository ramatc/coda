import type { MetadataRoute } from "next";
import { fetchSitemapEntries } from "../lib/sitemap";
import { getSiteUrl } from "../lib/site-url";

/**
 * Rendered per request instead of at build time: the API is not reachable
 * during `next build`, and a prerendered file would freeze the degraded,
 * landing-only result. The API read itself is cached (see `lib/sitemap.ts`).
 */
export const dynamic = "force-dynamic";

/**
 * `sitemap.xml`: the landing page plus every album and every public list page,
 * as absolute URLs on the public site URL. Review pages are not listed yet.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();
  const { albums, lists } = await fetchSitemapEntries();

  return [
    { url: `${siteUrl}/` },
    ...albums.map((album) => ({
      url: `${siteUrl}/albums/${album.id}`,
      lastModified: album.updatedAt,
    })),
    ...lists.map((list) => ({
      url: `${siteUrl}/lists/${list.id}`,
      lastModified: list.updatedAt,
    })),
  ];
}
