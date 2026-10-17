/**
 * Public base URL of the web app, used as `metadataBase` so canonical and
 * Open Graph URLs resolve to absolute links search engines can follow. Falls
 * back to the local dev port when `NEXT_PUBLIC_SITE_URL` is unset, the same
 * posture as `getApiBaseUrl` in `lib/api-client.ts`.
 */
export function getSiteUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}
