import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";

interface HeaderProps {
  /** `/u/{username}` for a resolved viewer, degrading to `/home` (see AppShell). */
  youHref: string;
  /** First letter of the viewer's username, shown in the avatar placeholder. */
  youInitial: string;
}

/**
 * Compact top bar for this milestone's routes (`/home`, `/feed`): the "CODA"
 * wordmark, a "+ LOG" action, search, and the viewer's avatar. No "ARCHIVE"
 * suffix and no Following/For-you tabs — Home and Feed are now two distinct
 * surfaces (editorial dashboard vs. full activity stream), not two filters of
 * the same content, so a tab pair between them would be misleading.
 *
 * "+ LOG" and the search icon both point at `/search` today: the app has no
 * standalone "log an entry" flow yet (logging happens on an album's own
 * detail page, via `AlbumActions`), and search is the real first step to get
 * there. Revisit once a dedicated quick-log flow exists.
 */
export function Header({ youHref, youInitial }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border-subtle bg-background/95 px-4 py-3 backdrop-blur">
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
      <div className="flex items-center gap-3">
        <Link
          href="/search"
          className="rounded-card border border-coda px-3 py-1.5 text-xs font-semibold text-coda hover:bg-coda-subtle"
        >
          + LOG
        </Link>
        <Link
          href="/search"
          aria-label="Search"
          className="text-text-secondary hover:text-text-primary"
        >
          <Search className="h-5 w-5" aria-hidden="true" />
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
    </header>
  );
}
