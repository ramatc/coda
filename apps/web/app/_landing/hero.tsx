import Link from "next/link";

const HERO_HEADING_ID = "landing-hero-heading";

/**
 * Opening section of the public landing (`/`). It owns the page's only `<h1>`
 * (the public header carries a wordmark link, not a heading) and offers two
 * ways in: the primary sign-up call to action, and a secondary hash anchor to
 * the on-page trending section so a visitor can look around before committing.
 *
 * Synchronous and data-free: nothing here depends on the viewer or the API, so
 * it renders the same for anonymous and signed-in visitors.
 */
export function Hero() {
  return (
    <section
      aria-labelledby={HERO_HEADING_ID}
      className="border-b border-border-subtle px-4 py-20 lg:px-6 lg:py-28"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-coda">
          Coda Archive
        </p>
        <h1
          id={HERO_HEADING_ID}
          className="max-w-3xl text-4xl font-black tracking-tight text-text-primary sm:text-5xl lg:text-6xl"
        >
          Your after-hours music archive.
        </h1>
        <p className="max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">
          Rate every album on a 1-10 scale, write the review it deserves, and
          keep the lists that tell the story of your listening.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            href="/sign-up"
            className="rounded-card bg-coda px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coda-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Start your archive
          </Link>
          <a
            href="#trending"
            className="rounded-card border border-border-strong px-5 py-2.5 text-sm font-semibold text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda"
          >
            Explore trending
          </a>
        </div>
      </div>
    </section>
  );
}
