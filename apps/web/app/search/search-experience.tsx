"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { searchCatalog } from "../../lib/search";
import type {
  AlbumSearchResult,
  PopularAlbum,
  SearchResults as SearchResultsData,
} from "../../lib/search";
import { SearchResults } from "./search-results";

/** Debounce delay for the as-you-type search input, in milliseconds. */
const SEARCH_DEBOUNCE_MS = 300;

interface SearchExperienceProps {
  /** Server-fetched initial "popular" albums shown before the user types. */
  initialPopular: PopularAlbum[];
}

/** Adapts a popular-album card to the album-result shape the grid renders. */
function popularToAlbum(album: PopularAlbum): AlbumSearchResult {
  return {
    id: album.id,
    title: album.title,
    primaryArtistName: album.primaryArtistName,
    coverUrl: album.coverUrl,
    releaseYear: null,
  };
}

/**
 * Discover search client island (container/presentational split): owns the
 * as-you-type interaction and query state, and delegates rendering to the pure
 * {@link SearchResults}. Before the user types anything it shows the
 * server-rendered "popular" albums; once they type it shows live, debounced
 * results. A per-request sequence guard discards out-of-order responses so a
 * slower earlier response never overwrites a faster later one (same pattern as
 * the onboarding wizard's search).
 */
export function SearchExperience({ initialPopular }: SearchExperienceProps) {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultsData | null>(null);

  const stateRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    seq: number;
  }>({ timer: null, seq: 0 });

  // Clear any pending debounce timer on unmount so a stray `setTimeout` never
  // fires `setResults` after navigation away from `/search`.
  useEffect(() => {
    const state = stateRef.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  function onChange(value: string): void {
    setQuery(value);
    const state = stateRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (value.trim().length === 0) {
      // Back to the initial "popular" view; bump the sequence so any in-flight
      // response is ignored.
      state.seq += 1;
      setResults(null);
      return;
    }

    state.timer = setTimeout(() => {
      void run(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function run(value: string): Promise<void> {
    const state = stateRef.current;
    const requestSeq = ++state.seq;

    const token = await getToken();
    const data = await searchCatalog(token, value);

    if (requestSeq !== state.seq) {
      // A newer search started since this request was issued — discard it.
      return;
    }
    if (data) {
      setResults(data);
    }
  }

  const showingResults = query.trim().length > 0 && results !== null;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-brand-600">Discover</h1>
        <p className="text-base opacity-70">
          Search albums and artists across the catalog.
        </p>
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search albums and artists…"
        aria-label="Search the catalog"
        className="rounded-card border border-brand-200 px-4 py-3 text-base"
      />

      {showingResults ? (
        <SearchResults
          albumsHeading="Albums"
          albums={results.albums}
          artists={results.artists}
          emptyMessage={`No results for "${query.trim()}".`}
        />
      ) : (
        <SearchResults
          albumsHeading="Popular"
          albums={initialPopular.map(popularToAlbum)}
          emptyMessage="No albums in the catalog yet — an import is still populating it."
        />
      )}
    </main>
  );
}
