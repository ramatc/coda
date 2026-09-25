"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, ArrowRight, Check, Compass, Search, X } from "lucide-react";
import { cn } from "@coda/ui";
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

/** Ordered step metadata for the progress indicator. */
const STEPS: { key: Step; label: string }[] = [
  { key: "genres", label: "Genres" },
  { key: "artists", label: "Artists" },
  { key: "albums", label: "Albums" },
];

interface OnboardingWizardProps {
  genres: GenreOption[];
  /**
   * A small handful of real, popularity-ranked albums (`GET /search/popular`,
   * server-fetched in `page.tsx`) used purely as editorial dressing for the
   * left panel's record collage — never mock data, just a different real
   * source than the genre/artist/album pickers themselves. Optional so the
   * panel degrades gracefully (no collage) if the catalog has nothing yet.
   */
  spotlightAlbums?: AlbumOption[];
}

/**
 * Multi-step onboarding wizard (client island).
 * Steps: pick genres → pick a favorite artist → (optional)
 * pick up to {@link MAX_ALBUMS} albums → submit. Genres come pre-fetched from
 * the server page (fixed taxonomy); artists and albums default to genre-based
 * suggestions (`GET /onboarding/{artists,albums}/suggested`) seeded from
 * `selectedGenres`, and switch to live search results once the user types a
 * query (search overrides suggestions, never merges with them — see
 * `displayedArtists`/`displayedAlbums`). Submission goes through the
 * `completeOnboarding` Server Action; the API is the real validation authority.
 */
export function OnboardingWizard({
  genres,
  spotlightAlbums = [],
}: OnboardingWizardProps) {
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
  const [suggestedArtists, setSuggestedArtists] = useState<ArtistOption[]>([]);
  const [albumQuery, setAlbumQuery] = useState("");
  const [albumResults, setAlbumResults] = useState<AlbumOption[]>([]);
  const [suggestedAlbums, setSuggestedAlbums] = useState<AlbumOption[]>([]);

  const [genreFilterQuery, setGenreFilterQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // Per-kind debounce timer + request sequence number, so a slower earlier
  // response can never overwrite a faster later one, and every keystroke
  // doesn't fire its own request.
  const searchStateRef = useRef<
    Record<SearchKind, { timer: ReturnType<typeof setTimeout> | null; seq: number }>
  >({
    artists: { timer: null, seq: 0 },
    albums: { timer: null, seq: 0 },
  });

  // Clears any pending debounced search timers on unmount so a stray
  // `setTimeout` never fires `setArtistResults`/`setAlbumResults` after the
  // user has navigated away from `/onboarding`. The ref object itself is
  // never reassigned, only mutated in place, so capturing it here (rather
  // than re-reading `searchStateRef.current` inside the cleanup) still sees
  // the latest timer ids at unmount time.
  useEffect(() => {
    const state = searchStateRef.current;
    return () => {
      if (state.artists.timer) clearTimeout(state.artists.timer);
      if (state.albums.timer) clearTimeout(state.albums.timer);
    };
  }, []);

  // Seeds the artists step with genre-based suggestions so it opens already
  // populated instead of empty-until-search. Re-fetches whenever the step is
  // entered or the genre selection changes; fails safe on a network error by
  // keeping whatever suggestions are already on screen (same posture as
  // `runSearch` below). Once the user types a query, `displayedArtists`
  // switches to live search results — this effect keeps running in the
  // background but never overwrites an active search.
  useEffect(() => {
    if (step !== "artists" || selectedGenres.size === 0) {
      return;
    }
    let ignore = false;
    (async () => {
      try {
        const token = await getToken();
        const genresParam = [...selectedGenres].join(",");
        const res = await fetch(
          `${getApiBaseUrl()}/onboarding/artists/suggested?genres=${encodeURIComponent(genresParam)}`,
          { headers: { Authorization: `Bearer ${token ?? ""}` } },
        );
        if (ignore || !res.ok) {
          return;
        }
        setSuggestedArtists((await res.json()) as ArtistOption[]);
      } catch {
        // Network failure or a rejected getToken(): fail safe, same as
        // runSearch — keep whatever suggestions are already on screen.
      }
    })();
    return () => {
      ignore = true;
    };
    // getToken is intentionally excluded: Clerk does not guarantee a stable
    // function identity across renders, and this effect should only re-run
    // when the step or the genre selection actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedGenres]);

  // Same as above, for the albums step.
  useEffect(() => {
    if (step !== "albums" || selectedGenres.size === 0) {
      return;
    }
    let ignore = false;
    (async () => {
      try {
        const token = await getToken();
        const genresParam = [...selectedGenres].join(",");
        const res = await fetch(
          `${getApiBaseUrl()}/onboarding/albums/suggested?genres=${encodeURIComponent(genresParam)}`,
          { headers: { Authorization: `Bearer ${token ?? ""}` } },
        );
        if (ignore || !res.ok) {
          return;
        }
        setSuggestedAlbums((await res.json()) as AlbumOption[]);
      } catch {
        // Network failure or a rejected getToken(): fail safe, keep whatever
        // suggestions are already on screen.
      }
    })();
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedGenres]);

  const submittable = isOnboardingSubmittable(
    selectedGenres.size,
    selectedArtists.size,
    selectedAlbums.size,
  );

  /** Distinct category labels, in first-seen order, from the real API data. */
  const categories = useMemo(
    () => [...new Set(genres.map((genre) => genre.category))],
    [genres],
  );

  /**
   * Client-side genre filter (category pill + free-text) — the taxonomy is
   * small (18 rows) and fully loaded already, so this never needs its own
   * server round-trip, unlike artist/album search.
   */
  const filteredGenres = useMemo(() => {
    const q = genreFilterQuery.trim().toLowerCase();
    return genres.filter((genre) => {
      if (categoryFilter && genre.category !== categoryFilter) {
        return false;
      }
      if (q.length === 0) {
        return true;
      }
      return (
        genre.name.toLowerCase().includes(q) ||
        genre.descriptor.toLowerCase().includes(q)
      );
    });
  }, [genres, categoryFilter, genreFilterQuery]);

  // Search results (once the user types) override suggestions rather than
  // merging with them, per the design: suggestions are the default state,
  // search is the override state.
  const displayedArtists =
    artistQuery.trim().length > 0 ? artistResults : suggestedArtists;
  const displayedAlbums =
    albumQuery.trim().length > 0 ? albumResults : suggestedAlbums;

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

  /**
   * "Skip for now" does not bypass onboarding — there is no such capability
   * server-side. It navigates to `/home` like any other link; the real
   * `resolveOnboardingRedirect` gate (in `lib/onboarding.ts`, enforced on
   * every gated route) sends an incomplete user straight back here. This is
   * intentionally honest rather than a dead decoration.
   */
  function onSkip() {
    router.push(HOME_PATH);
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

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background text-text-primary">
      {/* Restrained, violet-tinted atmospheric backdrop — one authored moment,
          not per-section decoration. Fully decorative (aria-hidden, inert to
          pointer events) and never carries content. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-[20%] -left-[10%] h-[55vw] w-[55vw] rounded-full bg-surface-1/50 blur-[130px]" />
        <div className="absolute top-[35%] -right-[15%] h-[45vw] w-[45vw] rounded-full bg-coda/5 blur-[160px]" />
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "72px 72px",
          }}
        />
      </div>

      <OnboardingTopBar onSkip={onSkip} />

      <main className="relative z-10 mx-auto flex w-full max-w-[1440px] flex-1 flex-col justify-center px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:gap-14">
          <EditorialPanel genreCount={selectedGenres.size} spotlightAlbums={spotlightAlbums} />

          <div className="flex flex-col gap-4 lg:col-span-7">
            {/* Condensed identity strip — replaces the full editorial panel below `lg`. */}
            <div className="flex flex-col gap-1 lg:hidden">
              <p className="text-sm text-text-secondary">
                Where the music player ends, your cultural history begins.
              </p>
            </div>

            <div className="rounded-card border border-border-subtle bg-surface-1/90 p-5 shadow-xl backdrop-blur-md sm:p-8">
              <ProgressSteps stepIndex={stepIndex} />

              {error ? (
                <p
                  role="alert"
                  className="mb-6 rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
                >
                  {error}
                </p>
              ) : null}

              <form onSubmit={onSubmit} className="flex flex-col gap-6">
                {step === "genres" ? (
                  <section aria-label="Pick genres" className="flex flex-col gap-6">
                    <StepHeading
                      title="Welcome to Coda"
                      subtitle="Tell us what you love so we can tune your recommendations."
                    />

                    <SelectionRule
                      rule={`Pick at least ${MIN_GENRES} genres.`}
                      count={selectedGenres.size}
                    />

                    <div className="flex flex-col gap-3">
                      <SearchField
                        value={genreFilterQuery}
                        onChange={setGenreFilterQuery}
                        placeholder="Search genres (e.g. Ambient, Trap, Jazz...)"
                      />
                      <div
                        role="group"
                        aria-label="Filter genres by category"
                        className="flex flex-wrap gap-1.5"
                      >
                        <CategoryPill
                          label="All Spheres"
                          active={categoryFilter === null}
                          onClick={() => setCategoryFilter(null)}
                        />
                        {categories.map((category) => (
                          <CategoryPill
                            key={category}
                            label={category}
                            active={categoryFilter === category}
                            onClick={() =>
                              setCategoryFilter((prev) =>
                                prev === category ? null : category,
                              )
                            }
                          />
                        ))}
                      </div>
                    </div>

                    {filteredGenres.length === 0 ? (
                      <p className="text-sm italic text-text-tertiary">
                        No genres match that filter.
                      </p>
                    ) : (
                      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                        {filteredGenres.map((genre) => {
                          const active = selectedGenres.has(genre.slug);
                          return (
                            <li key={genre.slug}>
                              <button
                                type="button"
                                aria-pressed={active}
                                onClick={() => toggleGenre(genre.slug)}
                                className={cn(
                                  "flex w-full flex-col gap-1 rounded-card border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                                  active
                                    ? "border-coda bg-coda text-white shadow-[0_4px_16px_-4px] shadow-coda/40"
                                    : "border-border-subtle bg-background hover:border-border-strong hover:bg-surface-2",
                                )}
                              >
                                <span className="flex items-center justify-between gap-2">
                                  <span
                                    className={cn(
                                      "text-sm font-bold tracking-tight",
                                      active ? "text-white" : "text-text-primary",
                                    )}
                                  >
                                    {genre.name}
                                  </span>
                                  <span
                                    aria-hidden="true"
                                    className={cn(
                                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                                      active
                                        ? "bg-white text-coda"
                                        : "border border-border-strong text-transparent",
                                    )}
                                  >
                                    <Check className="h-2.5 w-2.5 stroke-[3]" />
                                  </span>
                                </span>
                                <span
                                  className={cn(
                                    "truncate text-xs",
                                    active ? "text-white/80" : "text-text-secondary",
                                  )}
                                >
                                  {genre.descriptor}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4 font-mono text-[11px] text-text-tertiary">
                      <span>Your taste shapes every recommendation</span>
                      <span className="hidden sm:inline">
                        Next: pick a few artists you love →
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={onSkip}
                        className="text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
                      >
                        Skip for now
                      </button>
                      <CtaButton
                        disabled={selectedGenres.size < MIN_GENRES}
                        onClick={() => setStep("artists")}
                      >
                        <span>Next: Artists</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </CtaButton>
                    </div>
                  </section>
                ) : null}

                {step === "artists" ? (
                  <section aria-label="Pick artists" className="flex flex-col gap-6">
                    <StepHeading
                      title="Favorite artists"
                      subtitle="Suggested from the genres you just picked — search for anyone else."
                    />

                    <SelectionRule
                      rule={`Add at least ${MIN_ARTISTS} favorite artist (${selectedArtists.size} selected).`}
                      count={selectedArtists.size}
                    />

                    <SearchField
                      value={artistQuery}
                      onChange={(value) => {
                        setArtistQuery(value);
                        search("artists", value);
                      }}
                      placeholder="Search artists…"
                    />

                    <PickerGrid
                      items={displayedArtists}
                      ariaLabel="Artists"
                      emptyMessage="No artists yet — the catalog is still importing."
                      getId={(artist) => artist.id}
                      isSelected={(artist) => selectedArtists.has(artist.id)}
                      isAtCap={() => selectedArtists.size >= MAX_ARTISTS}
                      onToggle={toggleArtist}
                      renderContent={(artist, active) => (
                        <span className="flex items-center gap-3">
                          {artist.imageUrl ? (
                            <img
                              src={artist.imageUrl}
                              alt=""
                              className="h-10 w-10 shrink-0 rounded-full object-cover"
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-text-secondary"
                            >
                              {artist.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
                            <span className="truncate text-sm font-medium text-text-primary">
                              {artist.name}
                            </span>
                            {active ? (
                              <Check
                                className="h-4 w-4 shrink-0 text-coda"
                                aria-hidden="true"
                              />
                            ) : null}
                          </span>
                        </span>
                      )}
                    />

                    <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                      <BackButton onClick={() => setStep("genres")}>
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Back to genres</span>
                      </BackButton>
                      <CtaButton
                        disabled={selectedArtists.size < MIN_ARTISTS}
                        onClick={() => setStep("albums")}
                      >
                        <span>Next: Albums</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </CtaButton>
                    </div>
                  </section>
                ) : null}

                {step === "albums" ? (
                  <section aria-label="Pick albums" className="flex flex-col gap-6">
                    <StepHeading
                      title="Cornerstone albums"
                      subtitle="Optional — a few records that already define your taste."
                    />

                    <SelectionRule
                      rule={`Optionally add up to ${MAX_ALBUMS} favorite albums (${selectedAlbums.size} selected).`}
                      count={selectedAlbums.size}
                    />

                    <SearchField
                      value={albumQuery}
                      onChange={(value) => {
                        setAlbumQuery(value);
                        search("albums", value);
                      }}
                      placeholder="Search albums…"
                    />

                    <PickerGrid
                      items={displayedAlbums}
                      ariaLabel="Albums"
                      emptyMessage="No albums yet — the catalog is still importing."
                      getId={(album) => album.id}
                      isSelected={(album) => selectedAlbums.has(album.id)}
                      isAtCap={() => selectedAlbums.size >= MAX_ALBUMS}
                      onToggle={toggleAlbum}
                      gridClassName="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                      renderContent={(album, active) => (
                        <>
                          <span className="relative block aspect-square w-full overflow-hidden rounded-artwork bg-surface-2">
                            {album.coverUrl ? (
                              <img
                                src={album.coverUrl}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span
                                aria-hidden="true"
                                className="flex h-full w-full items-center justify-center text-lg font-semibold text-text-secondary"
                              >
                                {album.title.charAt(0).toUpperCase()}
                              </span>
                            )}
                            {active ? (
                              <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-coda text-white">
                                <Check className="h-3 w-3" aria-hidden="true" />
                              </span>
                            ) : null}
                          </span>
                          <span className="flex flex-col gap-0.5 px-0.5 pb-1">
                            <span className="truncate text-sm font-medium text-text-primary">
                              {album.title}
                            </span>
                            <span className="truncate text-xs text-text-secondary">
                              {album.primaryArtistName}
                            </span>
                          </span>
                        </>
                      )}
                    />

                    <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                      <BackButton onClick={() => setStep("artists")}>
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Back to artists</span>
                      </BackButton>
                      <CtaButton
                        type="submit"
                        disabled={!submittable || status === "submitting"}
                      >
                        <span>
                          {status === "submitting" ? "Saving…" : "Finish calibration"}
                        </span>
                        {status === "submitting" ? null : (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        )}
                      </CtaButton>
                    </div>
                  </section>
                ) : null}
              </form>
            </div>
          </div>
        </div>
      </main>

      <OnboardingFooter />
    </div>
  );
}

interface OnboardingTopBarProps {
  onSkip: () => void;
}

/** Top identity bar — brand mark, the "you're onboarding" context label, and
 * the one global way out (see {@link OnboardingWizard.onSkip}). */
function OnboardingTopBar({ onSkip }: OnboardingTopBarProps) {
  return (
    <header className="relative z-20 border-b border-border-subtle/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-xl font-black uppercase tracking-tight text-text-primary sm:text-2xl">
            Coda
          </span>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs font-medium text-text-secondary underline decoration-border-subtle underline-offset-4 transition-colors hover:text-text-primary hover:decoration-coda"
        >
          Skip for now
        </button>
      </div>
    </header>
  );
}

interface EditorialPanelProps {
  genreCount: number;
  spotlightAlbums: AlbumOption[];
}

/**
 * Left brand/editorial column — desktop only (`lg:flex`, hidden below that;
 * `OnboardingWizard` renders a condensed one-line replacement for narrower
 * viewports instead of this panel). The record collage uses whatever real
 * popular albums were passed in; with none it just skips that block rather
 * than inventing artwork.
 */
function EditorialPanel({ genreCount, spotlightAlbums }: EditorialPanelProps) {
  const [left, center, right] = spotlightAlbums;

  return (
    <aside className="hidden flex-col gap-6 lg:col-span-5 lg:flex">
      <div className="relative overflow-hidden rounded-card border border-border-subtle bg-surface-1/70 p-6 backdrop-blur-sm lg:p-8">
        {left || center || right ? (
          <div className="relative my-7 flex items-center justify-center">
            <div
              aria-hidden="true"
              className="absolute h-56 w-56 rounded-full border border-border-subtle/40"
            />
            <div
              aria-hidden="true"
              className="absolute h-72 w-72 rounded-full border border-border-subtle/20"
            />
            <div className="relative z-10 flex items-center justify-center -space-x-8">
              {left ? <SpotlightCover album={left} size="sm" rotate="-rotate-6" /> : null}
              {center ? (
                <SpotlightCover album={center} size="lg" rotate="" caption />
              ) : null}
              {right ? <SpotlightCover album={right} size="sm" rotate="rotate-6" /> : null}
            </div>
          </div>
        ) : null}

        <div className="space-y-3 pt-2">
          <p className="font-serif text-lg leading-snug text-text-primary sm:text-xl">
            &ldquo;Where the music player ends, your cultural history begins.&rdquo;
          </p>
          <p className="text-xs leading-relaxed text-text-secondary">
            Coda is not a stream or background noise. It is an editorial diary
            and taste provenance network. Every genre and record you log tunes
            your discovery algorithm with zero corporate promotion.
          </p>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-border-subtle/70 pt-4 font-mono text-[11px]">
          <span className="uppercase tracking-wide text-text-secondary">
            Active diary nodes
          </span>
          <span className="font-semibold text-coda" aria-live="polite">
            {genreCount} {genreCount === 1 ? "genre" : "genres"} calibrated
          </span>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-card border border-border-subtle/60 bg-surface-1/30 p-4 text-xs text-text-secondary">
        <Compass className="mt-0.5 h-4 w-4 shrink-0 text-coda" aria-hidden="true" />
        <div>
          <span className="mb-0.5 block font-semibold text-text-primary">
            Explainable Discovery
          </span>
          We never recommend music through opaque black boxes. Your genres
          directly calibrate the social graph and crate-digging modules.
        </div>
      </div>
    </aside>
  );
}

interface SpotlightCoverProps {
  album: AlbumOption;
  size: "sm" | "lg";
  rotate: string;
  caption?: boolean;
}

/** One record in the editorial panel's overlapping collage. */
function SpotlightCover({ album, size, rotate, caption }: SpotlightCoverProps) {
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-artwork border shadow-2xl transition-transform duration-300 hover:rotate-0",
        size === "lg"
          ? "z-10 h-36 w-36 border-2 border-coda/60 shadow-[0_12px_40px_rgba(0,0,0,0.8)] hover:scale-105 sm:h-40 sm:w-40"
          : "h-28 w-28 border-border-subtle sm:h-32 sm:w-32",
        rotate,
      )}
    >
      {album.coverUrl ? (
        <img src={album.coverUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center bg-surface-2 text-lg font-semibold text-text-secondary"
        >
          {album.title.charAt(0).toUpperCase()}
        </span>
      )}
      {caption ? (
        <div className="absolute inset-x-2 bottom-2 truncate rounded border border-border-subtle bg-background/85 px-2 py-1 backdrop-blur-md">
          <p className="truncate text-[10px] text-text-primary">
            {album.primaryArtistName.toUpperCase()}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Editorial footer bar — static brand copy, present on every step. */
function OnboardingFooter() {
  return (
    <footer className="relative z-20 border-t border-border-subtle/40 bg-background/60 py-4">
      <div className="mx-auto flex max-w-[1440px] flex-col items-center justify-between gap-3 px-5 font-mono text-[11px] text-text-tertiary sm:flex-row sm:px-8 lg:px-12">
        <div className="flex items-center gap-2">
          <span className="font-bold text-text-primary">Coda Archive</span>
          <span aria-hidden="true">•</span>
          <span>Nocturnal music diary &amp; social curation</span>
        </div>
        <div className="flex items-center gap-3">
          <span>Zero algorithms without provenance</span>
        </div>
      </div>
    </footer>
  );
}

interface ProgressStepsProps {
  stepIndex: number;
}

/** Horizontal numbered progress indicator shared by all three steps. */
function ProgressSteps({ stepIndex }: ProgressStepsProps) {
  return (
    <ol aria-label="Onboarding steps" className="mb-8 flex items-center">
      {STEPS.map((s, i) => {
        const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "upcoming";
        return (
          <li
            key={s.key}
            className={cn(
              "flex items-center gap-2",
              i < STEPS.length - 1 && "flex-1",
            )}
          >
            <span className="flex items-center gap-2">
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                  state === "upcoming" && "bg-surface-2 text-text-tertiary",
                  state === "current" && "bg-coda text-white",
                  state === "done" && "bg-surface-2 text-text-primary",
                )}
              >
                {state === "done" ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "text-xs font-semibold uppercase tracking-wide",
                  state === "upcoming" ? "text-text-tertiary" : "text-text-primary",
                )}
              >
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px flex-1",
                  state === "done" ? "bg-coda" : "bg-border-subtle",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

interface StepHeadingProps {
  title: string;
  subtitle: string;
}

function StepHeading({ title, subtitle }: StepHeadingProps) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
        {title}
      </h1>
      <p className="text-sm leading-relaxed text-text-secondary sm:text-base">
        {subtitle}
      </p>
    </div>
  );
}

interface SelectionRuleProps {
  rule: string;
  count: number;
}

/** Real rule text (from the API's own capture bounds) + a live counter chip. */
function SelectionRule({ rule, count }: SelectionRuleProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border-subtle bg-background px-4 py-3">
      <p className="text-sm text-text-secondary">
        <span className="mr-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-text-tertiary">
          Selection rule:
        </span>
        <span className="font-semibold text-text-primary">{rule}</span>
      </p>
      <span className="shrink-0 rounded-full border border-coda/40 bg-coda-subtle px-2.5 py-1 text-xs font-bold text-coda">
        {count} selected
      </span>
    </div>
  );
}

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

function SearchField({ value, onChange, placeholder }: SearchFieldProps) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-card border border-border-subtle bg-background py-2.5 pl-9 pr-9 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda"
      />
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

interface CategoryPillProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function CategoryPill({ label, active, onClick }: CategoryPillProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-card px-3 py-1 text-[11px] font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "bg-surface-2 text-text-primary"
          : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary",
      )}
    >
      {label}
    </button>
  );
}

interface CtaButtonProps {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}

/**
 * Primary call to action — muted/disabled until the step's rule is met,
 * coda-violet once enabled. Hand-rolled rather than `@coda/ui`'s `Button`:
 * that component is still on the legacy `brand-*` palette (see
 * `packages/ui/src/components/button.tsx`), which is the wrong violet for
 * this dark surface and assumes a light background, so reusing it would
 * fight the After Hours Archive tokens rather than express them.
 */
function CtaButton({ children, disabled, onClick, type = "button" }: CtaButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-11 w-fit items-center justify-center gap-2 rounded-card px-6 text-xs font-bold uppercase tracking-wide transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-sm",
        disabled
          ? "cursor-not-allowed bg-surface-2 text-text-tertiary"
          : "bg-coda text-white shadow-lg shadow-coda/25 hover:brightness-110",
      )}
    >
      {children}
    </button>
  );
}

interface BackButtonProps {
  children: ReactNode;
  onClick: () => void;
}

function BackButton({ children, onClick }: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 w-fit items-center justify-center gap-1.5 rounded-card px-4 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-sm"
    >
      {children}
    </button>
  );
}

interface PickerGridProps<T> {
  items: T[];
  ariaLabel: string;
  emptyMessage: string;
  getId: (item: T) => string;
  isSelected: (item: T) => boolean;
  /**
   * True once the relevant cap ({@link MAX_ARTISTS}/{@link MAX_ALBUMS}) has
   * been reached — combined with `isSelected` by this component so an
   * already-selected item stays clickable (to allow deselect) regardless.
   */
  isAtCap: (item: T) => boolean;
  onToggle: (item: T) => void;
  renderContent: (item: T, active: boolean) => ReactNode;
  gridClassName?: string;
}

/** Dense grid of toggleable artist/album cards, replacing the old list. */
function PickerGrid<T>({
  items,
  ariaLabel,
  emptyMessage,
  getId,
  isSelected,
  isAtCap,
  onToggle,
  renderContent,
  gridClassName,
}: PickerGridProps<T>) {
  if (items.length === 0) {
    return <p className="text-sm italic text-text-tertiary">{emptyMessage}</p>;
  }
  return (
    <ul
      aria-label={ariaLabel}
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-3",
        gridClassName,
      )}
    >
      {items.map((item) => {
        const id = getId(item);
        const active = isSelected(item);
        const disabled = !active && isAtCap(item);
        return (
          <li key={id}>
            <button
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onToggle(item)}
              className={cn(
                "flex w-full flex-col gap-2 rounded-card border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "border-coda bg-coda-subtle"
                  : "border-border-subtle bg-background hover:border-border-strong hover:bg-surface-2",
                disabled && "pointer-events-none opacity-40",
              )}
            >
              {renderContent(item, active)}
              {disabled ? (
                <span className="px-0.5 text-[11px] italic text-text-tertiary">
                  max reached
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
