import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  LIST_NOT_FOUND,
  albumCountLabel,
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
import { AppShell } from "../../_shell/app-shell";

interface ListPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Search-engine metadata for the list page. Always read ANONYMOUSLY, so a
 * private list (a 404 to anyone but its owner) can never leak its title into
 * metadata — even when its owner is the one viewing. Such a list, or an
 * unknown one, is marked not indexable; an API failure falls back to the site
 * defaults and leaves the error to the page.
 */
export async function generateMetadata({
  params,
}: ListPageProps): Promise<Metadata> {
  const { id } = await params;
  let list: Awaited<ReturnType<typeof fetchList>>;
  try {
    list = await fetchList(null, id);
  } catch {
    return {};
  }
  if (list === LIST_NOT_FOUND) {
    return { robots: { index: false, follow: false } };
  }

  // `||`, not `??`: a blank description falls back too, never an empty snippet.
  const description =
    list.description?.trim() ||
    `A list of ${albumCountLabel(list.items.length)} on Coda.`;
  const canonical = `/lists/${list.id}`;
  return {
    title: list.title,
    description,
    alternates: { canonical },
    openGraph: { title: list.title, description, url: canonical },
  };
}

/**
 * List detail page at `/lists/[id]` (server component). It is PUBLIC: absent
 * from `protectedRoutePatterns` (only `/lists` and `/lists/new` are protected),
 * so anonymous visitors and search engines can read public lists. The API's
 * `GET /lists/:id` answers a private list with 404 to anyone but its owner, so
 * `notFound()` never leaks a private list's existence.
 *
 * For a signed-in viewer the page runs the onboarding gate (same pattern as
 * `/albums/[id]`), then fetches the list and the viewer's own local user id IN
 * PARALLEL — one round-trip latency instead of two — because ownership can only
 * be decided by comparing `ListDetail.userId` against the viewer's LOCAL id,
 * which the API exposes solely through `GET /profile`.
 *
 * An anonymous visitor skips the gate (it would bounce them to `/onboarding`)
 * and the profile read: they are definitively not the owner, so no
 * ownership-unverified notice applies.
 *
 * The owner islands (edit, delete, reorder) are always handed down;
 * {@link ListDetailView} renders them only for the owner. The like island is
 * handed down the same way but is NOT owner-gated at the other end: likes
 * follow the list's READ visibility, so anyone signed in who can see this page
 * may like it, its owner included, and an anonymous visitor gets a sign-in
 * prompt from the island itself. Its seed state comes straight off the payload
 * — `viewerHasLiked` describes the caller whose token fetched it.
 */
export default async function ListPage({ params }: ListPageProps) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();
  const signedIn = token !== null;

  if (signedIn) {
    const status = await fetchOnboardingStatus(token);
    const redirectTo = resolveOnboardingRedirect(status, `/lists/${id}`);
    if (redirectTo) {
      redirect(redirectTo);
    }
  }

  const [list, viewerUserId] = await Promise.all([
    fetchList(token, id),
    signedIn ? fetchViewerUserId(token) : Promise.resolve(null),
  ]);

  if (list === LIST_NOT_FOUND) {
    notFound();
  }

  // For a signed-in viewer, `viewerUserId` is only `null` when
  // `fetchViewerUserId` could not resolve their own id (a transient
  // `GET /profile` failure). That is indistinguishable from "not the owner" for
  // `isListOwner`, so it is surfaced separately here to tell the page's degraded
  // rendering apart from a definitive visitor.
  const ownershipUnverified = signedIn && viewerUserId === null;

  const view = (
    <ListDetailView
      list={list}
      isOwner={isListOwner(list, viewerUserId)}
      ownershipUnverified={ownershipUnverified}
      likeAction={
        <ListLikeButton
          listId={list.id}
          initialLikeCount={list.likeCount}
          initialHasLiked={list.viewerHasLiked}
          canInteract={signedIn}
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

  // Signed-in surfaces only, matching `/albums/[id]`: the shell's header
  // and nav are not shown to an anonymous visitor.
  return signedIn ? await AppShell({ children: view }) : view;
}
