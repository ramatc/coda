import Link from "next/link";
import Image from "next/image";
import { PublicNav } from "./public-nav";

/**
 * Logged-out top bar for the public landing (`/`): the monogram + "CODA"
 * wordmark (linking to `/`, not `/home`), the on-page {@link PublicNav}, and
 * the two entry points into the app — "Sign in" and "Get started".
 *
 * Deliberately a separate component rather than a variant of the
 * authenticated `Header` (`_shell/header.tsx`): that one requires a resolved
 * viewer (`youHref`/`youInitial`) and renders "+ LOG", search and the avatar,
 * none of which have a logged-out shape. This header resolves no session at
 * all — no Clerk call, no avatar, no profile link — so `/` renders the same
 * chrome for every visitor.
 */
export function PublicHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border-subtle bg-background/95 px-4 py-3 backdrop-blur lg:px-6">
      <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 lg:gap-8">
        <div className="flex items-center gap-6 lg:gap-8">
          <Link
            href="/"
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
          <PublicNav />
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/sign-in"
            className="text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-card bg-coda px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-coda-hover"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
