import Link from "next/link";

const FINAL_CTA_HEADING_ID = "landing-final-cta-heading";

/**
 * Closing call to action for the public landing (`/`), just above the footer.
 * Sign-up is the primary action; "Sign in" is the quieter secondary path for
 * returning members. It resolves no session, so signed-in visitors see the
 * same prompt as everyone else (the landing adds no redirect by design).
 */
export function FinalCta() {
  return (
    <section
      aria-labelledby={FINAL_CTA_HEADING_ID}
      className="px-4 py-20 lg:px-6 lg:py-24"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-6 rounded-card border border-coda-muted bg-coda-subtle p-8 lg:flex-row lg:items-center lg:justify-between lg:p-12">
        <div className="flex max-w-xl flex-col gap-3">
          <h2
            id={FINAL_CTA_HEADING_ID}
            className="text-3xl font-black tracking-tight text-text-primary sm:text-4xl"
          >
            Start your archive tonight.
          </h2>
          <p className="text-base leading-relaxed text-text-secondary">
            Log your first album in under a minute. Free, and yours to keep.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/sign-up"
            className="rounded-card bg-coda px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-coda-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Create your free account
          </Link>
          <Link
            href="/sign-in"
            className="text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
