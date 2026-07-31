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
import { DeleteListButton } from "./delete-list-button";
import { EditListForm } from "./edit-list-form";
import { ListDetailView } from "./list-detail";
import { ListLikeButton } from "./list-like-button";
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
 * so `notFound()` never leaks a private list's existence. The owner islands
 * (edit, delete, reorder) are always handed down; {@link ListDetailView} renders
 * them only for the owner.
 *
 * The like island is handed down the same way but is NOT owner-gated at the
 * other end: likes follow the list's READ visibility, so anyone who can see this
 * page may like it, its owner included. Its seed state comes straight off the
 * payload — `viewerHasLiked` describes the caller whose token fetched it and is
 * never derived here.
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

  // `viewerUserId` is only `null` when `fetchViewerUserId` could not resolve the
  // viewer's own id (a transient `GET /profile` failure — this page is already
  // behind the Clerk/onboarding gate, so a signed-in, synced viewer always has
  // one). That is indistinguishable from "not the owner" for `isListOwner`, so
  // it is surfaced separately here to tell the page's degraded rendering apart
  // from a definitive visitor.
  const ownershipUnverified = viewerUserId === null;

  return (
    <ListDetailView
      list={list}
      isOwner={isListOwner(list, viewerUserId)}
      ownershipUnverified={ownershipUnverified}
      likeAction={
        <ListLikeButton
          listId={list.id}
          initialLikeCount={list.likeCount}
          initialHasLiked={list.viewerHasLiked}
        />
      }
      ownerActions={
        <>
          <EditListForm list={list} />
          <DeleteListButton list={list} />
        </>
      }
    >
      <ListReorder listId={list.id} items={list.items} />
    </ListDetailView>
  );
}
