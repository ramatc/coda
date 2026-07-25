import type { ReactNode } from "react";
import Link from "next/link";
import {
  EMPTY_LIST_MESSAGE,
  type ListDetail,
  type ListItem,
} from "../../../lib/lists";

interface ListDetailViewProps {
  list: ListDetail;
  /** Whether the viewer owns this list — drives the owner-vs-visitor render. */
  isOwner: boolean;
  /**
   * True when the server page could not resolve the viewer's own local user id
   * (a transient `GET /profile` failure), so `isOwner` is a fail-safe `false`
   * rather than a definitive answer. Surfaced as a visible notice so a real
   * owner hit by a transient error sees WHY their controls are missing, instead
   * of the page silently looking like a read-only visitor view.
   */
  ownershipUnverified?: boolean;
  /**
   * The owner-only reorder island. Rendered IN PLACE OF the read-only item list
   * (never alongside it), and only for the owner — the server page hands it
   * down unconditionally, the same way `/u/[username]` hands down its
   * owner-only avatar island.
   */
  children?: ReactNode;
}

/** `N albums`, singularized for a one-album list. */
function albumCountLabel(count: number): string {
  return count === 1 ? "1 album" : `${count} albums`;
}

/**
 * Presentational list detail (container/presentational split): a pure,
 * synchronous component with no data-fetching or auth concerns, so it renders in
 * a plain unit test. The async server page resolves the list plus the viewer's
 * ownership and composes this with the owner's reorder island.
 *
 * A visitor gets a static, read-only rendering of the same items. The `Private`
 * marker is surfaced only to the owner — every other viewer gets a 404 for a
 * private list, so there is no case where a visitor could see it.
 */
export function ListDetailView({
  list,
  isOwner,
  ownershipUnverified,
  children,
}: ListDetailViewProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      {ownershipUnverified ? (
        <p className="text-sm text-red-600" role="alert">
          Could not verify ownership of this list — refresh to retry.
        </p>
      ) : null}

      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">{list.title}</h1>
        <p className="text-sm opacity-70" data-testid="list-summary">
          <span>{list.isRanked ? "Ranked" : "Unranked"}</span>
          <span> · </span>
          <span>{albumCountLabel(list.items.length)}</span>
          {isOwner && !list.isPublic ? (
            <>
              <span> · </span>
              <span>Private</span>
            </>
          ) : null}
        </p>
        {list.description ? (
          <p className="whitespace-pre-line text-base">{list.description}</p>
        ) : (
          <p className="text-sm italic opacity-50">No description yet.</p>
        )}
      </header>

      <section aria-label="List items">
        {isOwner && children ? (
          children
        ) : (
          <ReadOnlyItems items={list.items} />
        )}
      </section>
    </main>
  );
}

/**
 * The visitor's static rendering of a list's items. Ordinals come from the
 * array index rather than the stored `position` so the numbering a visitor sees
 * matches the owner's optimistically-renumbered island exactly — the API keeps
 * `position` contiguous, so the two agree, and the index never shows a gap if
 * they ever disagree.
 */
function ReadOnlyItems({ items }: { items: ListItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm italic opacity-50">{EMPTY_LIST_MESSAGE}</p>;
  }

  return (
    <ol className="flex flex-col divide-y divide-brand-100">
      {items.map((item, index) => (
        <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
          <span className="w-8 shrink-0 text-right tabular-nums opacity-50">
            {index + 1}.
          </span>
          <span className="flex flex-1 flex-col">
            <Link href={`/albums/${item.album.id}`} className="font-medium">
              {item.album.title}
            </Link>
            <span className="opacity-70">{item.album.primaryArtistName}</span>
            {item.note ? (
              <span className="text-xs italic opacity-60">{item.note}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
