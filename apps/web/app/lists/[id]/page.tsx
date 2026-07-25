import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  LIST_NOT_FOUND,
  fetchList,
  fetchViewerUserId,
  isListOwner,
} from "../../../lib/lists";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../../lib/onboarding";
import { ListDetailView } from "./list-detail";
import { ListReorder } from "./list-reorder";

interface ListPageProps {
  params: Promise<{ id: string }>;
}

/**
 * List detail page at `/lists/[id]` (server component), protected by the Clerk
 * middleware. Runs the onboarding gate (same pattern as `/albums/[id]`), then
 * fetches the list and the viewer's own local user id IN PARALLEL — one
 * round-trip latency instead of two — because ownership can only be decided by
 * comparing `ListDetail.userId` against the viewer's LOCAL id, which the API
 * exposes solely through `GET /profile`.
 *
 * A 404 covers both an unknown list and a private list the viewer may not see,
 * so `notFound()` never leaks a private list's existence. The reorder island is
 * always handed down; {@link ListDetailView} renders it only for the owner.
 */
export default async function ListPage({ params }: ListPageProps) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, `/lists/${id}`);
  if (redirectTo) {
    redirect(redirectTo);
  }

  const [list, viewerUserId] = await Promise.all([
    fetchList(token, id),
    fetchViewerUserId(token),
  ]);

  if (list === LIST_NOT_FOUND) {
    notFound();
  }

  return (
    <ListDetailView list={list} isOwner={isListOwner(list, viewerUserId)}>
      <ListReorder listId={list.id} items={list.items} />
    </ListDetailView>
  );
}
