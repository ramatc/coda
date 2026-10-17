const DEFAULT_SITE_URL = "http://localhost:3000";

/**
 * Public base URL of the web app (an origin, no trailing slash), used as
 * `metadataBase` so canonical and Open Graph URLs resolve to absolute links
 * search engines can follow. Read from `NEXT_PUBLIC_SITE_URL`, which Next
 * inlines at BUILD time, so a production build must set it.
 *
 * Never throws, because the root layout builds a `URL` from it on every page: a
 * value without a scheme (`coda.app`) is taken as https, and an unparseable one
 * or an unset variable falls back to the local dev port, the same posture as
 * `getApiBaseUrl` in `lib/api-client.ts`.
 */
export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) {
    return DEFAULT_SITE_URL;
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}
