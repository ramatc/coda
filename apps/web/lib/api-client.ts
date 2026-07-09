/**
 * Base URL of the Coda API. Server Components and client islands both call the
 * Nest API (the single data authority, Decision #9) with a Clerk-issued token
 * rather than touching the database directly. Falls back to the local dev port
 * when `NEXT_PUBLIC_API_URL` is unset.
 */
export function getApiBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return base.replace(/\/+$/, "");
}
