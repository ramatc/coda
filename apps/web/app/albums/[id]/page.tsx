import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ALBUM_NOT_FOUND, fetchAlbumDetail } from "../../../lib/albums";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../../lib/onboarding";
import { fetchViewerOwnLists } from "../../../lib/lists";
import { AlbumDetailView } from "./album-detail";
import { AlbumActions } from "./album-actions";
import { AppShell } from "../../_shell/app-shell";
import { SignInPrompt } from "../../_shell/sign-in-prompt";

interface AlbumPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Album detail page at `/albums/[id]` (server component). This is the route the
 * search results (PR7) link to, and it is PUBLIC: it is absent from
 * `protectedRoutePatterns` so anonymous visitors and search engines can read it,
 * and the API's `GET /albums/:id` answers them with an empty viewer state.
 *
 * The page forks on whether `auth()` yields a token:
 *
 * - **Signed in:** runs the onboarding gate (same pattern as `/u/[username]`),
 *   fetches the album detail with the viewer's token in a single round-trip
 *   (metadata + tracklist + aggregate rating + the viewer's own tracking state)
 *   and the viewer's own lists IN PARALLEL (they populate the action island's
 *   "add to list" picker and never gate the page), then renders the view with
 *   the action island inside {@link AppShell}, matching `/home` and `/feed`.
 * - **Anonymous:** skips the onboarding gate (it would bounce the visitor to
 *   `/onboarding`) and the own-lists read, and renders the view with a single
 *   sign-in prompt in place of the action island. No {@link AppShell}: its
 *   header and nav are signed-in surfaces, the same call `/reviews/[id]` makes.
 *
 * An unknown album 404s either way.
 */
export default async function AlbumPage({ params }: AlbumPageProps) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();
  const albumPath = `/albums/${id}`;

  if (token === null) {
    const album = await fetchAlbumDetail(null, id);
    if (album === ALBUM_NOT_FOUND) {
      notFound();
    }
    return (
      <AlbumDetailView album={album}>
        <SignInPrompt
          returnTo={albumPath}
          label="Sign in to track this album"
        />
      </AlbumDetailView>
    );
  }

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, albumPath);
  if (redirectTo) {
    redirect(redirectTo);
  }

  const [album, ownLists] = await Promise.all([
    fetchAlbumDetail(token, id),
    fetchViewerOwnLists(token),
  ]);
  if (album === ALBUM_NOT_FOUND) {
    notFound();
  }

  // Called (and awaited) as a plain async function rather than used as JSX —
  // see the comment in `app/home/page.tsx` for why.
  return await AppShell({
    children: (
      <AlbumDetailView album={album}>
        <AlbumActions
          albumId={album.id}
          viewer={album.viewer}
          ownLists={ownLists}
        />
      </AlbumDetailView>
    ),
  });
}
