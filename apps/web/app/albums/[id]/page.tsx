import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  ALBUM_NOT_FOUND,
  fetchAlbumDetail,
} from "../../../lib/albums";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../../lib/onboarding";
import { AlbumDetailView } from "./album-detail";
import { AlbumActions } from "./album-actions";

interface AlbumPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Album detail page at `/albums/[id]` (server component), protected by the
 * Clerk middleware. This is the route the search results (PR7) link to. It runs
 * the onboarding gate (same pattern as `/u/[username]`), fetches the album
 * detail from the API with the viewer's token in a single round-trip (metadata
 * + tracklist + aggregate rating + the viewer's own tracking state), then
 * renders the pure {@link AlbumDetailView} composed with the viewer's action
 * island. An unknown album 404s.
 */
export default async function AlbumPage({ params }: AlbumPageProps) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, `/albums/${id}`);
  if (redirectTo) {
    redirect(redirectTo);
  }

  const album = await fetchAlbumDetail(token, id);
  if (album === ALBUM_NOT_FOUND) {
    notFound();
  }

  return (
    <AlbumDetailView album={album}>
      <AlbumActions albumId={album.id} viewer={album.viewer} />
    </AlbumDetailView>
  );
}
