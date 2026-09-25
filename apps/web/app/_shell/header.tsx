import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";
import { DesktopNav } from "./desktop-nav";

interface HeaderProps {
  /** `/u/{username}` for a resolved viewer, degrading to `/home` (see AppShell). */
  youHref: string;
  /** First letter of the viewer's username, shown in the avatar placeholder. */
  youInitial: string;
}

/**
 * Top bar for this milestone's routes (`/home`, `/feed`): the "CODA"
 * wordmark, a "+ LOG" action, search, and the viewer's avatar. No "ARCHIVE"
 * suffix and no Following/For-you tabs — Home and Feed are now two distinct
 * surfaces (editorial dashboard vs. full activity stream), not two filters of
 * the same content, so a tab pair between them would be misleading.
 *
 * From `lg` up, {@link DesktopNav} takes over the primary-nav job `BottomNav`
 * plays on narrower viewports (see `AppShell`, which hides `BottomNav` at
 * `lg`), and a search field replaces the bare search icon — same destination
 * (`/search`) either way.
 *
 * "+ LOG" and search both point at `/search` today: the app has no
 * standalone "log an entry" flow yet (logging happens on an album's own
 * detail page, via `AlbumActions`), and search is the real first step to get
 * there. Revisit once a dedicated quick-log flow exists.
 */
export function Header({ youHref, youInitial }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border-subtle bg-background/95 px-4 py-3 backdrop-blur lg:px-6">
      <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 lg:gap-8">
        <div className="flex items-center gap-6 lg:gap-8">
          <Link
            href="/home"
            className="flex items-center gap-2 text-lg font-black tracking-tight text-text-primary"
          >
            <Image
              src="/brand/coda-monogram.png"
              alt=""
              width={223}
              height={222}
              priority
              className="h-7 w-auto"
            />
            CODA
          </Link>
          <DesktopNav />
        </div>
        <div className="flex items-center gap-3">
          {/*
           * Desktop search entry point: styled like a text field but is a plain
           * link to `/search` — no client state, no fake interactivity. Real
           * as-you-type search stays on `/search` itself.
           */}
          <Link
            href="/search"
            className="hidden w-56 items-center gap-2 rounded border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs text-text-secondary hover:border-coda lg:flex"
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Search albums, artists...
          </Link>
          <Link
            href="/search"
            aria-label="Search"
            className="text-text-secondary hover:text-text-primary lg:hidden"
          >
            <Search className="h-5 w-5" aria-hidden="true" />
          </Link>
          <Link
            href="/search"
            className="rounded-card border border-coda px-3 py-1.5 text-xs font-semibold text-coda hover:bg-coda-subtle lg:border-transparent lg:bg-coda lg:text-white lg:hover:bg-coda-hover lg:hover:text-white"
          >
            + LOG
          </Link>
          <Link href={youHref} aria-label="Your profile">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-text-primary"
              data-testid="header-avatar"
            >
              {youInitial}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
