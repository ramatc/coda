import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { INVALID_CURSOR, fetchFeed } from "../../lib/feed";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { FeedList } from "./feed-list";

interface FeedPageProps {
  searchParams: Promise<{ cursor?: string }>;
}

/**
 * Followed-activity feed at `/feed` (server component), protected by the Clerk
 * middleware. Runs the onboarding gate (same pattern as `/activity` and `/home`),
 * then server-renders the activity — listens, ratings, reviews — of every user the
 * viewer FOLLOWS, most recent first, from `GET /feed`. This is the fan-IN inverse
 * of `/activity` (which shows only the viewer's OWN activity); an unsynced or
 * follows-nobody caller gets an explicit empty state, which the API returns as
 * `{ items: [], nextCursor: null }`.
 *
 * Pagination is cursor-based and fully server-rendered: the page reads a
 * `?cursor=` search param, fetches that page, and renders a "Load older activity"
 * link to the next cursor when one exists — no client island needed. A malformed
 * `?cursor=` (hand-edited or stale) makes the API 400; rather than crashing into
 * Next's default error boundary, it is treated as "no cursor" and falls back to
 * the first page (mirrors `/activity` and the `ALBUM_NOT_FOUND` sentinel pattern).
 */
export default async function FeedPage({ searchParams }: FeedPageProps) {
  const { cursor } = await searchParams;
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/feed");
  if (redirectTo) {
    redirect(redirectTo);
  }

  let page = await fetchFeed(token, cursor);
  if (page === INVALID_CURSOR) {
    page = await fetchFeed(token);
  }
  if (page === INVALID_CURSOR) {
    // The API rejects an absent cursor as invalid too — unreachable in
    // practice, but keeps the type narrowed without an unsafe cast.
    throw new Error("Failed to load feed.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold text-brand-600">Your feed</h1>

      <FeedList items={page.items} />

      {page.nextCursor ? (
        <Link
          href={`/feed?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="self-center text-sm font-medium text-brand-600 hover:underline"
        >
          Load older activity
        </Link>
      ) : null}
    </main>
  );
}
