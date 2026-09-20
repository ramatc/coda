import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { fetchRecommendations } from "../../lib/recommendations";
import { fetchPopularAlbums } from "../../lib/search";
import { fetchFeed, INVALID_CURSOR } from "../../lib/feed";
import { Recommendations } from "./recommendations";
import { PopularRow } from "./popular-row";
import { FriendsPreview } from "./friends-preview";
import { AppShell } from "../_shell/app-shell";

/** How many followed-activity items to show before "See full feed". */
const FRIENDS_PREVIEW_COUNT = 3;
/** How many popular albums to show in the Home row. */
const POPULAR_ROW_COUNT = 10;

/**
 * Home page at `/home` (server component), protected by the Clerk middleware and
 * onboarding-gated: a signed-in user who has NOT completed onboarding is
 * redirected to `/onboarding` before any home content renders.
 *
 * Editorial/discovery dashboard, NOT an infinite timeline — the full
 * followed-activity stream stays at `/activity` and `/feed`. Every section
 * reuses an existing, UNMODIFIED endpoint (no backend change in this pass):
 *  - "Popular" reuses `GET /search/popular` (the same data the discover page
 *    shows). That endpoint orders by a static, global `popularityScore` — NOT
 *    time-windowed — so the heading says "Popular", not "this week", rather
 *    than claim a freshness the data doesn't have.
 *  - "New from friends" reuses `GET /feed`'s first page, sliced client-side to
 *    a small preview, linking out to the full `/feed` for the rest.
 *  - "For your ears" is the existing {@link Recommendations} island, unchanged.
 * "Popular with people you follow" and "Lists worth exploring" need real new
 * backend queries (see the Home-redesign audit) and are deliberately left out
 * of this UI-only pass. Wrapped in {@link AppShell}, which supersedes the old
 * inline "Discover"/"Your activity" nav — both are now covered by the
 * BottomNav (Search, Diary).
 */
export default async function HomePage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/home");
  if (redirectTo) {
    redirect(redirectTo);
  }

  const [popularAlbums, feedPage, recommendations] = await Promise.all([
    fetchPopularAlbums(token),
    fetchFeed(token),
    fetchRecommendations(token),
  ]);

  const friendsPreview =
    feedPage === INVALID_CURSOR
      ? []
      : feedPage.items.slice(0, FRIENDS_PREVIEW_COUNT);

  // Called (and awaited) as a plain async function rather than used as JSX:
  // plain `react-dom` rendering (the render path these unit tests use, unlike
  // Next's own RSC pipeline) cannot resolve a NESTED async Server Component —
  // only the top-level one a test itself awaits. Awaiting it here yields
  // fully-resolved JSX either way, so this is a no-op difference in production.
  return await AppShell({
    children: (
      <main className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-8">
        <section aria-label="Popular" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Popular
          </h2>
          <PopularRow albums={popularAlbums.slice(0, POPULAR_ROW_COUNT)} />
        </section>

        <section aria-label="New from friends" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              New from friends
            </h2>
            <Link
              href="/feed"
              className="text-xs font-medium text-coda hover:underline"
            >
              See full feed
            </Link>
          </div>
          <FriendsPreview items={friendsPreview} />
        </section>

        <section aria-label="For your ears" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            For your ears
          </h2>
          <Recommendations items={recommendations} />
        </section>
      </main>
    ),
  });
}
