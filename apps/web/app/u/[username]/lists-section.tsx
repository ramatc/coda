import Link from "next/link";
import {
  albumCountLabel,
  EMPTY_LISTS_MESSAGE,
  EMPTY_PUBLIC_LISTS_MESSAGE,
  type ListSummary,
} from "../../../lib/lists";

interface ListsSectionProps {
  /**
   * The lists to show, exactly as `GET /users/:username/lists` returned them:
   * newest first, already filtered to what this viewer may see (all of them for
   * the owner, public ones only for anyone else). This component never re-sorts
   * and never re-filters — visibility is the API's decision, not the UI's.
   */
  lists: ListSummary[];
  /**
   * True when the viewer is looking at their OWN profile. Drives only two
   * things: the private marker (owner-scoped copy) and the empty state's wording
   * plus its create-a-list call to action.
   */
  isOwnProfile: boolean;
}

/**
 * The "Lists" profile section. A pure, synchronous presentational component —
 * every mutation for a list lives on the list's own page (`/lists/[id]`) or on
 * the create page (`/lists/new`), so this section owns no state, no auth and no
 * requests, and renders in a plain unit test.
 *
 * That is the deliberate difference from its sibling
 * `want-to-listen-section.tsx`, which IS a client island: the backlog's only
 * affordance (remove one entry) exists nowhere else, so it has to live in the
 * section. Here every affordance already has a home, and duplicating it would
 * mean two places to keep in sync.
 *
 * The section always renders, even with nothing in it, so a profile never looks
 * like it is missing a feature.
 */
export function ListsSection({ lists, isOwnProfile }: ListsSectionProps) {
  return (
    <section aria-label="Lists" className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">Lists</h2>

      {lists.length === 0 ? (
        <EmptyLists isOwnProfile={isOwnProfile} />
      ) : (
        <ul className="flex flex-col divide-y divide-brand-100">
          {lists.map((list) => (
            <li key={list.id} className="flex flex-col gap-1 py-2 text-sm">
              <Link href={`/lists/${list.id}`} className="font-medium">
                {list.title}
              </Link>
              <span className="opacity-70">
                {summaryLabel(list, isOwnProfile)}
              </span>
              {list.description ? (
                <span className="text-xs italic opacity-60">
                  {list.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One row's meta line, e.g. `Ranked · 3 albums · Private`. Built as a single
 * string rather than separated spans so the whole label is one readable text
 * node for a screen reader (and one assertion in a test).
 *
 * The private marker is gated on `isOwnProfile` for the same reason
 * `list-detail.tsx` gates its own: the API never sends a private list to anyone
 * but its owner, so the marker is owner-scoped copy and has no meaning — and no
 * legitimate way to appear — on a visitor's view.
 */
function summaryLabel(list: ListSummary, isOwnProfile: boolean): string {
  const parts = [
    list.isRanked ? "Ranked" : "Unranked",
    albumCountLabel(list.itemCount),
  ];
  if (isOwnProfile && !list.isPublic) {
    parts.push("Private");
  }
  return parts.join(" · ");
}

/**
 * The empty state. The owner gets the create-a-list call to action because this
 * is the moment they need it; a visitor gets nothing to act on, since creating a
 * list has nothing to do with the profile they are standing on. Same posture as
 * the album page's empty "add to list" picker, which is the other place a user
 * discovers `/lists/new`.
 */
function EmptyLists({ isOwnProfile }: { isOwnProfile: boolean }) {
  if (!isOwnProfile) {
    return (
      <p className="text-sm italic opacity-50">{EMPTY_PUBLIC_LISTS_MESSAGE}</p>
    );
  }

  return (
    <p className="text-sm italic opacity-50">
      {EMPTY_LISTS_MESSAGE}{" "}
      <Link href="/lists/new" className="underline">
        Create your first list
      </Link>
    </p>
  );
}
