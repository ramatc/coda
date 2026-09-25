const BRAND_HEADING_ID = "landing-brand-heading";

/**
 * Editorial positioning block for the public landing (`/`), placed after the
 * live trending/popular sections and before the closing call to action. It is
 * copy only: no links and no nav anchor id, since `PublicNav` does not point
 * here. Set in the sans UI face like the rest of the page chrome; the serif
 * face stays reserved for reviews and human opinion.
 */
export function BrandStatement() {
  return (
    <section
      aria-labelledby={BRAND_HEADING_ID}
      className="border-b border-border-subtle bg-surface-1 px-4 py-20 lg:px-6 lg:py-24"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-5 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-tertiary">
          After Hours Archive
        </p>
        <h2
          id={BRAND_HEADING_ID}
          className="text-3xl font-black tracking-tight text-text-primary sm:text-4xl"
        >
          Built for the records that stay with you after dark.
        </h2>
        <p className="text-base leading-relaxed text-text-secondary sm:text-lg">
          Coda is a diary for the albums you return to, not a feed to scroll
          past. Every score, review and list is yours to keep, and a quiet way
          to share what you have been listening to with the people who get it.
        </p>
      </div>
    </section>
  );
}
