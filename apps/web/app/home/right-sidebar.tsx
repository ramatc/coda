import Link from "next/link";
import { RatingScale } from "@coda/ui";
import type { ActivityItem } from "../../lib/activity";

interface RightSidebarProps {
  /** Already sliced to a small preview count by the page. */
  recentLogs: ActivityItem[];
}

/**
 * Home's right sidebar. Only "Recently Logged" ships in this pass, backed by
 * the viewer's real personal activity (`GET /me/activity`).
 *
 * "Your Week" (albums logged / average rating / new artists discovered this
 * week) and "Your Taste" (top genres / top artists) are deliberately NOT
 * rendered here — no endpoint aggregates either today (`ActivityService` and
 * `TasteProfile` both compute per-request internals, never exposed over HTTP),
 * and this component will not fabricate stats to fill the space. Add both
 * modules once a real aggregation endpoint exists for each.
 */
export function RightSidebar({ recentLogs }: RightSidebarProps) {
  return (
    <aside className="flex w-full flex-col gap-3.5 lg:border-l lg:border-border-subtle lg:pl-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-black uppercase tracking-wider text-text-primary">
          Recently Logged
        </h3>
        <Link
          href="/activity"
          className="text-[11px] font-medium text-text-secondary hover:text-coda"
        >
          Diary →
        </Link>
      </div>

      {recentLogs.length === 0 ? (
        <p className="text-xs italic text-text-tertiary">
          Nothing logged yet — rate or review an album to see it here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {recentLogs.map((item) => (
            <li key={item.id}>
              <Link
                href={`/albums/${item.album.id}`}
                className="flex items-center justify-between gap-2.5 rounded border border-border-subtle bg-surface-1/40 p-2.5 hover:bg-surface-1/80"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {item.album.coverUrl ? (
                    <img
                      src={item.album.coverUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded object-cover"
                      data-testid="recently-logged-cover"
                    />
                  ) : (
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-surface-2 text-xs font-semibold text-text-primary"
                      data-testid="recently-logged-cover-placeholder"
                      aria-hidden="true"
                    >
                      {item.album.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-text-primary">
                      {item.album.title}
                    </p>
                    <p className="truncate text-[10px] text-text-secondary">
                      {item.album.primaryArtistName} ·{" "}
                      {item.occurredAt.slice(0, 10)}
                    </p>
                  </div>
                </div>
                <RatingScale
                  value={item.score}
                  variant="personal"
                  size="sm"
                  showValue={false}
                  className="shrink-0"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
