import {
  sitemapEntrySchema,
  type SitemapEntries,
  type SitemapEntry,
} from "@coda/types";
import { getApiBaseUrl } from "./api-client";

const NO_ENTRIES: SitemapEntries = { albums: [], lists: [] };

/** How long `sitemap.xml` waits for the API before serving the static pages only. */
const SITEMAP_FETCH_TIMEOUT_MS = 10_000;

/** Keeps the entries that match the shared contract and drops the rest. */
function validEntries(value: unknown): SitemapEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.flatMap((entry) => {
    const parsed = sitemapEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function degraded(reason: string): SitemapEntries {
  console.warn(`[sitemap] serving static pages only: ${reason}`);
  return NO_ENTRIES;
}

/**
 * Reads the API's public `GET /sitemap` (no credentials: the payload is the
 * same for everyone). Never cached here, because the API caches the feed and a
 * degraded result must not stick. Degrades to no entries, with a warning, on
 * an error status, a network failure, a timeout or a payload that is not the
 * expected object, so `sitemap.xml` always renders at least the static pages.
 * A single malformed entry is dropped without discarding the rest.
 */
export async function fetchSitemapEntries(): Promise<SitemapEntries> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/sitemap`, {
      cache: "no-store",
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return degraded(`API answered ${response.status}`);
    }
    const body = (await response.json()) as {
      albums?: unknown;
      lists?: unknown;
    };
    const albums = validEntries(body?.albums);
    const lists = validEntries(body?.lists);
    if (albums === null || lists === null) {
      return degraded("unexpected payload shape");
    }
    return { albums, lists };
  } catch (error) {
    return degraded(error instanceof Error ? error.message : "request failed");
  }
}
