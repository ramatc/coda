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
import { fetchActivity, INVALID_CURSOR as INVALID_ACTIVITY_CURSOR } from "../../lib/activity";
import { Recommendations } from "./recommendations";
import { PopularRow } from "./popular-row";
import { FriendsPreview } from "./friends-preview";
import { RightSidebar } from "./right-sidebar";
import { AppShell } from "../_shell/app-shell";

/** How many followed-activity items to show before "See full feed". */
const FRIENDS_PREVIEW_COUNT = 3;
/** How many popular albums to show in the Home row — a single row, not a browse grid. */
const POPULAR_ROW_COUNT = 6;
/** How many of the viewer's own recent logs to show in the sidebar. */
const RECENTLY_LOGGED_COUNT = 3;

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
 *  - "Recently logged" (sidebar) reuses `GET /me/activity`'s first page, the
 *    viewer's OWN activity — distinct from `/feed`'s followed-users activity.
 * "Popular with people you follow" and "Lists worth exploring" (main column),
 * plus "Your Week" and "Your Taste" (sidebar), need real new backend
 * aggregations (see the Home-redesign audit) and are deliberately left out of
 * this UI-only pass — no fabricated stats or discovery lists.
 *
 * Layout is a 72/28 two-column grid from `lg` up (main content + sidebar);
 * below `lg` the sidebar stacks under the main column. Wrapped in
 * {@link AppShell}, whose `Header` now carries the primary nav on desktop
 * (`DesktopNav`) and hides `BottomNav` there.
 */
export default async function HomePage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/home");
  if (redirectTo) {
    redirect(redirectTo);
  }

  const [popularAlbums, feedPage, recommendations, activityPage] =
    await Promise.all([
      fetchPopularAlbums(token),
      fetchFeed(token),
      fetchRecommendations(token),
      fetchActivity(token),
    ]);

  const friendsPreview =
    feedPage === INVALID_CURSOR
      ? []
      : feedPage.items.slice(0, FRIENDS_PREVIEW_COUNT);

  const recentLogs =
    activityPage === INVALID_ACTIVITY_CURSOR
      ? []
      : activityPage.items.slice(0, RECENTLY_LOGGED_COUNT);

  // Called (and awaited) as a plain async function rather than used as JSX:
  // plain `react-dom` rendering (the render path these unit tests use, unlike
  // Next's own RSC pipeline) cannot resolve a NESTED async Server Component —
  // only the top-level one a test itself awaits. Awaiting it here yields
  // fully-resolved JSX either way, so this is a no-op difference in production.
  return await AppShell({
    children: (
      <div className="mx-auto flex max-w-[1240px] flex-col gap-10 px-4 py-6 lg:flex-row lg:gap-10 lg:px-6 lg:py-8">
        <main className="flex min-w-0 flex-col gap-10 lg:w-[72%]">
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
                View all activity →
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

        <div className="lg:w-[28%] lg:shrink-0">
          <RightSidebar recentLogs={recentLogs} />
        </div>
      </div>
    ),
  });
}
