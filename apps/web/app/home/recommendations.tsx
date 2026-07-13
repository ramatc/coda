"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  dismissRecommendation,
  type Recommendation,
} from "../../lib/recommendations";

interface RecommendationsProps {
  /** The server-fetched initial recommendations (strongest score first). */
  items: Recommendation[];
}

/** Human-facing "why" line for a recommendation, orphan-safe for a null reason. */
function reasonLabel(recommendation: Recommendation): string {
  if (recommendation.reason.matchedArtist) {
    return "Because you follow this artist";
  }
  if (recommendation.reason.topGenre) {
    return `Because you like ${recommendation.reason.topGenre}`;
  }
  return "Recommended for you";
}

/**
 * Home recommendations island (client): renders the viewer's recommendation
 * cards — each linking to the album detail page (`/albums/[id]`) — with a Dismiss
 * control. Dismissing calls the API, optimistically hides the card, then
 * `router.refresh()`es so the server page refetches the (now shorter) list —
 * the same server-authoritative pattern as the album-actions island. A failed
 * dismiss surfaces an inline error and keeps the card (no optimistic removal on
 * failure). An empty list renders an explicit empty state rather than nothing.
 *
 * Only recommendations are surfaced here — NOT the user's own activity (that
 * lives at `/activity`), per the spec's `/home` scope ("surfaces
 * recommendations/highlights only").
 */
export function Recommendations({ items }: RecommendationsProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = items.filter((item) => !dismissedIds.has(item.id));

  async function handleDismiss(id: string): Promise<void> {
    setPendingId(id);
    setError(null);
    try {
      const token = await getToken();
      await dismissRecommendation(token, id);
      setDismissedIds((prev) => new Set(prev).add(id));
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not dismiss this recommendation.",
      );
    } finally {
      setPendingId(null);
    }
  }

  if (visible.length === 0) {
    return (
      <p className="text-sm italic opacity-60" data-testid="recommendations-empty">
        No recommendations yet. Rate a few albums you love and check back soon.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visible.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-4 rounded-card border border-brand-100 p-3"
          >
            <Link
              href={`/albums/${item.album.id}`}
              className="flex flex-1 items-center gap-4"
            >
              {item.album.coverUrl ? (
                // Remote cover art rendered with a plain <img>; next/image
                // remote-pattern config is deferred (same as the search grid).
                <img
                  src={item.album.coverUrl}
                  alt={`${item.album.title} cover`}
                  className="h-16 w-16 rounded-card object-cover"
                  data-testid="recommendation-cover"
                />
              ) : (
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-card bg-brand-100 text-xl font-semibold text-brand-700"
                  data-testid="recommendation-cover-placeholder"
                >
                  {item.album.title.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{item.album.title}</span>
                <span className="text-xs opacity-70">
                  {item.album.primaryArtistName}
                  {item.album.releaseYear ? ` · ${item.album.releaseYear}` : ""}
                </span>
                <span className="text-xs font-medium text-brand-600">
                  {reasonLabel(item)}
                </span>
              </div>
            </Link>
            <button
              type="button"
              onClick={() => void handleDismiss(item.id)}
              disabled={pendingId === item.id}
              className="shrink-0 rounded-full border border-brand-200 px-3 py-1 text-xs font-medium opacity-70 hover:opacity-100 disabled:opacity-40"
              aria-label={`Dismiss ${item.album.title}`}
            >
              {pendingId === item.id ? "Dismissing…" : "Dismiss"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
