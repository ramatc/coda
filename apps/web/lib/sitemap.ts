import { sitemapEntriesSchema, type SitemapEntries } from "@coda/types";
import { getApiBaseUrl } from "./api-client";

const NO_ENTRIES: SitemapEntries = { albums: [], lists: [] };

/** How long Next reuses a successful sitemap read before asking the API again. */
export const SITEMAP_REVALIDATE_SECONDS = 3600;

/**
 * Reads the API's public `GET /sitemap` (no credentials: the payload is the
 * same for everyone). Degrades to no entries on an error status, a network
 * failure or a payload that does not match the shared contract, so
 * `sitemap.xml` always renders at least the static pages.
 */
export async function fetchSitemapEntries(): Promise<SitemapEntries> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/sitemap`, {
      next: { revalidate: SITEMAP_REVALIDATE_SECONDS },
    });
    if (!response.ok) {
      return NO_ENTRIES;
    }
    const parsed = sitemapEntriesSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : NO_ENTRIES;
  } catch {
    return NO_ENTRIES;
  }
}
