"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  EMPTY_WANT_TO_LISTEN_MESSAGE,
  unmarkWantToListen,
  type WantToListenEntry,
} from "../../../lib/want-to-listen";

interface WantToListenSectionProps {
  /**
   * The profile owner's unresolved backlog, newest first. The API already
   * applied read-time auto-resolve, so anything listened to or rated is absent
   * — this component never re-filters.
   */
  entries: WantToListenEntry[];
  /**
   * True when the viewer is looking at their OWN profile. Only then are the
   * per-entry remove controls rendered: `DELETE /want-to-listen/:albumId` is
   * scoped to the caller's own row, so offering it to a visitor would only ever
   * produce a 404.
   */
  isOwnProfile: boolean;
}

/**
 * The "want to listen" profile section (client island). Unlike a list, this
 * container is FIXED: it exists for every user, is never renamed, deleted or
 * reordered, and always renders — with an empty state — even when nothing is
 * marked. Only individual entries are added (from an album's page) and removed
 * (here), which is why the only control this component can ever render is a
 * per-entry remove.
 *
 * A removal drops the row OPTIMISTICALLY for instant feedback, then the request
 * settles: on success it `router.refresh()`es so the profile page re-reads the
 * backlog; on failure it RESTORES the row and surfaces the API's message, so a
 * rejected removal never leaves a phantom deletion on screen. Same posture as
 * `follow-button.tsx` and `list-reorder.tsx`, including their `useEffect`
 * re-sync from fresh server props — skipped while a request is in flight so it
 * never stomps a pending optimistic removal.
 *
 * The section heading is English like every other string in this app, rather
 * than the spec's Spanish "Quiero escuchar" label (a leftover of the
 * Spanish-language planning conversation); the section it names is unchanged.
 */
export function WantToListenSection({
  entries,
  isOwnProfile,
}: WantToListenSectionProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [visible, setVisible] = useState<WantToListenEntry[]>(entries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync from fresh server props after this island's own `router.refresh()`
  // lands (or after the owner resolved an album elsewhere). Skipped while
  // `busy` so it doesn't resurrect a row whose removal is still in flight.
  // Deliberately keyed only on `entries` — reacting to `busy` too would re-run
  // the moment a removal finishes, racing the rollback in `remove`.
  useEffect(() => {
    if (!busy) {
      setVisible(entries);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  async function remove(target: WantToListenEntry) {
    const previous = visible;

    setVisible(previous.filter((candidate) => candidate.id !== target.id));
    setBusy(true);
    setError(null);

    try {
      const token = await getToken();
      // Addressed by ALBUM id: the API scopes the delete to the caller's own
      // row for that album, so the entry's own id is never part of the URL.
      await unmarkWantToListen(token, target.albumId);
      router.refresh();
    } catch (err) {
      setVisible(previous);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Want to listen" className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">Want to listen</h2>

      {visible.length === 0 ? (
        <p className="text-sm italic opacity-50">
          {EMPTY_WANT_TO_LISTEN_MESSAGE}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-brand-100">
          {visible.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex flex-1 flex-col">
                <Link href={`/albums/${item.album.id}`} className="font-medium">
                  {item.album.title}
                </Link>
                <span className="opacity-70">
                  {item.album.primaryArtistName}
                </span>
              </span>
              {isOwnProfile ? (
                <button
                  type="button"
                  // The artist is part of the label so two entries sharing a
                  // title stay distinguishable to a screen reader.
                  aria-label={`Remove ${item.album.title} by ${item.album.primaryArtistName} from want to listen`}
                  disabled={busy}
                  onClick={() => void remove(item)}
                  className="rounded-card border border-brand-200 px-2 py-1 opacity-70"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
