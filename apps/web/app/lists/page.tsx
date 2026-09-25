import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { fetchViewerOwnLists } from "../../lib/lists";
import { ListsSection } from "../u/[username]/lists-section";

/**
 * The viewer's own lists at `/lists` (server component), protected by the
 * Clerk middleware and onboarding-gated like every other authenticated route.
 *
 * Reuses {@link fetchViewerOwnLists} (already relied on by the album page's
 * "add to list" picker) to resolve the viewer's username and fetch every list
 * they own — public and private alike — and renders them with the same
 * {@link ListsSection} the profile page uses, so this index and
 * `/u/[username]` never drift in how a list row looks or behaves.
 */
export default async function ListsPage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/lists");
  if (redirectTo) {
    redirect(redirectTo);
  }

  const lists = await fetchViewerOwnLists(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-12">
      <ListsSection lists={lists} isOwnProfile />
    </main>
  );
}
