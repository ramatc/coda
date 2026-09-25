import Link from "next/link";
import { albumCountLabel, type PopularList } from "../../lib/lists";
import { likeCountLabel } from "../../lib/reviews";
import { displayNameOrHandle } from "./display-name";

interface PopularListsSectionProps {
  lists: PopularList[];
}

const LISTS_HEADING_ID = "landing-lists-heading";

/**
 * Collage slots per card, a 2x2 grid. Mirrors the API's own
 * `LIST_PREVIEW_COVER_COUNT`; the payload is already cut to it, and the card
 * re-applies the cut so a wider payload can never break the grid.
 */
const COLLAGE_SLOTS = 4;

/**
 * The cover collage on a list card: up to four covers in a 2x2 grid, padded
 * with empty tiles when the list has fewer covers than slots, or a single
 * lettered tile when it has none. Decorative (`alt=""`, `aria-hidden`): the
 * card's title already names the list.
 */
function CoverCollage({ list }: { list: PopularList }) {
  const covers = list.previewCovers.slice(0, COLLAGE_SLOTS);

  if (covers.length === 0) {
    return (
      <div
        className="flex aspect-square w-full items-center justify-center rounded-card bg-surface-2 text-3xl font-black text-text-primary"
        data-testid="list-collage-placeholder"
        aria-hidden="true"
      >
        {list.title.charAt(0).toUpperCase()}
      </div>
    );
  }

  const emptySlots = COLLAGE_SLOTS - covers.length;
  return (
    <div
      className="grid aspect-square w-full grid-cols-2 gap-0.5 overflow-hidden rounded-card bg-surface-2"
      aria-hidden="true"
    >
      {covers.map((coverUrl, index) => (
        // Remote cover art rendered with a plain <img>; next/image
        // remote-pattern config is deferred (same as `PopularRow`).
        <img
          key={`${index}-${coverUrl}`}
          src={coverUrl}
          alt=""
          className="aspect-square h-full w-full object-cover"
        />
      ))}
      {Array.from({ length: emptySlots }, (_, index) => (
        <span key={`empty-${index}`} className="aspect-square bg-surface-2" />
      ))}
    </div>
  );
}

/**
 * Popular lists on the public landing (`/`), fed by `GET /lists/popular`
 * (recent public lists with enough albums to be worth a look). The section
 * carries `id="lists"`, the anchor `PublicNav` links to, so the id is a
 * contract and must not change on its own.
 *
 * Each card shows a cover collage, the title (linking to the list page, which
 * asks a logged-out visitor to sign in first), the owner, whether the list is
 * ranked, and its album and like counts. The count labels come from the lists
 * and reviews modules so their wording never drifts from the rest of the app.
 *
 * Synchronous and presentational: the page fetches the lists and passes them
 * in. An empty array (the fetch helper fails safe to `[]`) keeps the section
 * and its anchor, and shows an empty state instead of a blank gap.
 */
export function PopularListsSection({ lists }: PopularListsSectionProps) {
  return (
    <section
      id="lists"
      aria-labelledby={LISTS_HEADING_ID}
      className="scroll-mt-20 border-b border-border-subtle px-4 py-16 lg:px-6 lg:py-20"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8">
        <h2
          id={LISTS_HEADING_ID}
          className="text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          Popular lists
        </h2>
        {lists.length === 0 ? (
          <p className="text-sm text-text-tertiary">
            No public lists yet. Sign up and curate the first one.
          </p>
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {lists.map((list) => (
              <li
                key={list.id}
                className="flex flex-col gap-4 rounded-card border border-border-subtle bg-surface-1 p-4"
              >
                <CoverCollage list={list} />
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="line-clamp-2 text-base font-bold text-text-primary">
                      <Link
                        href={`/lists/${encodeURIComponent(list.id)}`}
                        className="hover:underline"
                      >
                        {list.title}
                      </Link>
                    </h3>
                    {list.isRanked ? (
                      <span className="shrink-0 rounded-card border border-coda-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-coda">
                        Ranked
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-text-secondary">
                    by {displayNameOrHandle(list.owner)}
                  </p>
                  {list.description ? (
                    <p
                      className="line-clamp-2 text-sm leading-relaxed text-text-tertiary"
                      data-testid="list-description"
                    >
                      {list.description}
                    </p>
                  ) : null}
                </div>
                <p className="mt-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                  <span>{albumCountLabel(list.itemCount)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{likeCountLabel(list.likeCount)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
