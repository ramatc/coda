"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { getApiBaseUrl } from "../../lib/api-client";
import {
  HOME_PATH,
  MAX_ALBUMS,
  MAX_ARTISTS,
  MIN_ARTISTS,
  MIN_GENRES,
  isOnboardingSubmittable,
  type AlbumOption,
  type ArtistOption,
  type GenreOption,
} from "../../lib/onboarding";
import { completeOnboarding } from "./actions";

type Step = "genres" | "artists" | "albums";
type Status = "idle" | "submitting" | "error";
type SearchKind = "artists" | "albums";

/** Debounce delay for the artist/album search inputs, in milliseconds. */
const SEARCH_DEBOUNCE_MS = 300;

interface OnboardingWizardProps {
  genres: GenreOption[];
}

/**
 * Multi-step onboarding wizard (client island). Steps: pick genres → pick a
 * favorite artist → (optional) pick up to {@link MAX_ALBUMS} albums → submit.
 * Genres come pre-fetched from the server page (fixed taxonomy); artists and
 * albums are searched live against the catalog (empty until PR5/PR6, so those
 * steps show an empty state gracefully). Submission goes through the
 * `completeOnboarding` Server Action; the API is the real validation authority.
 */
export function OnboardingWizard({ genres }: OnboardingWizardProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>("genres");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(new Set());
  const [selectedArtists, setSelectedArtists] = useState<
    Map<string, ArtistOption>
  >(new Map());
  const [selectedAlbums, setSelectedAlbums] = useState<Map<string, AlbumOption>>(
    new Map(),
  );

  const [artistQuery, setArtistQuery] = useState("");
  const [artistResults, setArtistResults] = useState<ArtistOption[]>([]);
  const [albumQuery, setAlbumQuery] = useState("");
  const [albumResults, setAlbumResults] = useState<AlbumOption[]>([]);

  // Per-kind debounce timer + request sequence number, so a slower earlier
  // response can never overwrite a faster later one, and every keystroke
  // doesn't fire its own request.
  const searchStateRef = useRef<
    Record<SearchKind, { timer: ReturnType<typeof setTimeout> | null; seq: number }>
  >({
    artists: { timer: null, seq: 0 },
    albums: { timer: null, seq: 0 },
  });

  const submittable = isOnboardingSubmittable(
    selectedGenres.size,
    selectedArtists.size,
    selectedAlbums.size,
  );

  function toggleGenre(slug: string) {
    setSelectedGenres((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }

  /**
   * Debounces the search-as-you-type input and discards out-of-order
   * responses: each call bumps a per-kind sequence number, and a response is
   * only applied if it is still the most recent request for that kind by the
   * time it resolves (a slower earlier response can otherwise land after a
   * faster later one and overwrite the current results with stale data).
   */
  function search(kind: SearchKind, query: string): void {
    const state = searchStateRef.current[kind];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const q = query.trim();
    if (q.length === 0) {
      state.seq += 1;
      if (kind === "artists") setArtistResults([]);
      else setAlbumResults([]);
      return;
    }

    state.timer = setTimeout(() => {
      void runSearch(kind, q);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(kind: SearchKind, q: string): Promise<void> {
    const state = searchStateRef.current[kind];
    const requestSeq = ++state.seq;

    try {
      const token = await getToken();
      const res = await fetch(
        `${getApiBaseUrl()}/onboarding/${kind}?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );

      if (requestSeq !== state.seq) {
        // A newer search has started since this request was issued — discard
        // this now-stale response.
        return;
      }
      if (!res.ok) {
        return;
      }
      if (kind === "artists") {
        setArtistResults((await res.json()) as ArtistOption[]);
      } else {
        setAlbumResults((await res.json()) as AlbumOption[]);
      }
    } catch {
      // Network failure or a rejected getToken(): fail safe by keeping
      // whatever results are already on screen rather than throwing an
      // unhandled promise rejection (same fail-safe posture as fetchGenres).
    }
  }

  function toggleArtist(artist: ArtistOption) {
    setSelectedArtists((prev) => {
      const next = new Map(prev);
      if (next.has(artist.id)) {
        next.delete(artist.id);
      } else if (next.size < MAX_ARTISTS) {
        next.set(artist.id, artist);
      }
      return next;
    });
  }

  function toggleAlbum(album: AlbumOption) {
    setSelectedAlbums((prev) => {
      const next = new Map(prev);
      if (next.has(album.id)) {
        next.delete(album.id);
      } else if (next.size < MAX_ALBUMS) {
        next.set(album.id, album);
      }
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // The genres/artists steps share this same `<form>` and have no
    // `type="submit"` button of their own, so pressing Enter while typing in
    // a search input would otherwise implicitly submit the form before the
    // final step. Only the "albums" step (which owns the submit button) may
    // actually submit.
    if (!submittable || step !== "albums") {
      return;
    }

    setStatus("submitting");
    setError(null);

    try {
      const result = await completeOnboarding({
        genreSlugs: [...selectedGenres],
        artistIds: [...selectedArtists.keys()],
        albumIds: [...selectedAlbums.keys()],
      });

      if (result.ok) {
        router.push(HOME_PATH);
        return;
      }
      setStatus("error");
      setError(result.error);
    } catch {
      setStatus("error");
      setError("Could not save your onboarding. Please retry.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-12">
      <header>
        <h1 className="text-3xl font-semibold text-brand-600">
          Welcome to Coda
        </h1>
        <p className="mt-2 text-base opacity-70">
          Tell us what you love so we can tune your recommendations.
        </p>
      </header>

      <ol className="flex gap-2 text-sm" aria-label="Onboarding steps">
        {(["genres", "artists", "albums"] as const).map((s) => (
          <li
            key={s}
            className={cn(
              "rounded-full px-3 py-1",
              step === s ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700",
            )}
          >
            {s}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        {step === "genres" ? (
          <section aria-label="Pick genres" className="flex flex-col gap-4">
            <p className="text-sm opacity-70">
              Pick at least {MIN_GENRES} genres ({selectedGenres.size} selected).
            </p>
            <div className="flex flex-wrap gap-2">
              {genres.map((genre) => {
                const active = selectedGenres.has(genre.slug);
                return (
                  <button
                    key={genre.slug}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleGenre(genre.slug)}
                    className={cn(
                      "rounded-full border px-4 py-2 text-sm",
                      active
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-brand-200 bg-white text-brand-800",
                    )}
                  >
                    {genre.name}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={selectedGenres.size < MIN_GENRES}
              onClick={() => setStep("artists")}
              className={cn(
                buttonVariants(),
                "w-fit",
                selectedGenres.size < MIN_GENRES && "pointer-events-none opacity-50",
              )}
            >
              Next
            </button>
          </section>
        ) : null}

        {step === "artists" ? (
          <section aria-label="Pick artists" className="flex flex-col gap-4">
            <p className="text-sm opacity-70">
              Add at least {MIN_ARTISTS} favorite artist ({selectedArtists.size}{" "}
              selected).
            </p>
            <input
              type="search"
              value={artistQuery}
              onChange={(e) => {
                setArtistQuery(e.target.value);
                search("artists", e.target.value);
              }}
              placeholder="Search artists…"
              className="rounded-card border border-brand-200 px-3 py-2"
            />
            <ResultList
              empty="No artists yet — the catalog is still importing."
              items={artistResults.map((a) => ({
                id: a.id,
                label: a.name,
                active: selectedArtists.has(a.id),
                onToggle: () => toggleArtist(a),
              }))}
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep("genres")}
                className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
              >
                Back
              </button>
              <button
                type="button"
                disabled={selectedArtists.size < MIN_ARTISTS}
                onClick={() => setStep("albums")}
                className={cn(
                  buttonVariants(),
                  "w-fit",
                  selectedArtists.size < MIN_ARTISTS &&
                    "pointer-events-none opacity-50",
                )}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}

        {step === "albums" ? (
          <section aria-label="Pick albums" className="flex flex-col gap-4">
            <p className="text-sm opacity-70">
              Optionally add up to {MAX_ALBUMS} favorite albums (
              {selectedAlbums.size} selected).
            </p>
            <input
              type="search"
              value={albumQuery}
              onChange={(e) => {
                setAlbumQuery(e.target.value);
                search("albums", e.target.value);
              }}
              placeholder="Search albums…"
              className="rounded-card border border-brand-200 px-3 py-2"
            />
            <ResultList
              empty="No albums yet — the catalog is still importing."
              items={albumResults.map((a) => ({
                id: a.id,
                label: `${a.title} — ${a.primaryArtistName}`,
                active: selectedAlbums.has(a.id),
                onToggle: () => toggleAlbum(a),
              }))}
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep("artists")}
                className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!submittable || status === "submitting"}
                className={cn(
                  buttonVariants(),
                  "w-fit",
                  (!submittable || status === "submitting") &&
                    "pointer-events-none opacity-50",
                )}
              >
                {status === "submitting" ? "Saving…" : "Finish"}
              </button>
            </div>
          </section>
        ) : null}
      </form>
    </main>
  );
}

interface ResultListProps {
  empty: string;
  items: { id: string; label: string; active: boolean; onToggle: () => void }[];
}

/** Small presentational list of toggleable search results. */
function ResultList({ empty, items }: ResultListProps) {
  if (items.length === 0) {
    return <p className="text-sm italic opacity-50">{empty}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-pressed={item.active}
            onClick={item.onToggle}
            className={cn(
              "w-full rounded-card border px-3 py-2 text-left text-sm",
              item.active
                ? "border-brand-600 bg-brand-50"
                : "border-brand-200 bg-white",
            )}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
