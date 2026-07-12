import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { INVALID_CURSOR, fetchActivity } from "../../lib/activity";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { ActivityFeed } from "./activity-feed";

interface ActivityPageProps {
  searchParams: Promise<{ cursor?: string }>;
}

/**
 * Personal activity stream at `/activity` (server component), protected by the
 * Clerk middleware. Runs the onboarding gate (same pattern as `/home` and the
 * album page), then server-renders the viewer's OWN activity — listens, ratings,
 * reviews — most recent first, from `GET /me/activity`. Never shows any other
 * user's activity (spec "No Social Fan-Out").
 *
 * Pagination is cursor-based and fully server-rendered: the page reads a
 * `?cursor=` search param, fetches that page, and renders a "Load older
 * activity" link to the next cursor when one exists — no client island needed.
 * A malformed `?cursor=` (e.g. hand-edited or stale) makes the API 400; rather
 * than letting that crash into Next's default error boundary, it's treated as
 * "no cursor" and falls back to the first page (mirrors the `ALBUM_NOT_FOUND`
 * sentinel pattern in `lib/albums.ts`).
 */
export default async function ActivityPage({
  searchParams,
}: ActivityPageProps) {
  const { cursor } = await searchParams;
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/activity");
  if (redirectTo) {
    redirect(redirectTo);
  }

  let page = await fetchActivity(token, cursor);
  if (page === INVALID_CURSOR) {
    page = await fetchActivity(token);
  }
  if (page === INVALID_CURSOR) {
    // The API rejects an absent cursor as invalid too — unreachable in
    // practice, but keeps the type narrowed without an unsafe cast.
    throw new Error("Failed to load activity.");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold text-brand-600">Your activity</h1>

      <ActivityFeed items={page.items} />

      {page.nextCursor ? (
        <Link
          href={`/activity?cursor=${encodeURIComponent(page.nextCursor)}`}
          className="self-center text-sm font-medium text-brand-600 hover:underline"
        >
          Load older activity
        </Link>
      ) : null}
    </main>
  );
}
