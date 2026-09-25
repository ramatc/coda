interface Feature {
  title: string;
  description: string;
}

/**
 * What a visitor gets out of Coda, as static copy. Local on purpose: this
 * section makes no API call, so it renders the same whether or not the
 * backend is reachable.
 */
const FEATURES: Feature[] = [
  {
    title: "Rate on a 1-10 scale",
    description:
      "Ten points, not five stars, so the gap between good and essential finally shows.",
  },
  {
    title: "Write real reviews",
    description:
      "Long-form, spoiler-aware reviews that sit next to your score, not instead of it.",
  },
  {
    title: "Curate lists",
    description:
      "Ranked or unranked, public or private: build the lists that explain your taste.",
  },
  {
    title: "Follow your people",
    description:
      "See what friends are logging tonight and find your next record through them.",
  },
];

const FEATURES_HEADING_ID = "landing-features-heading";

/**
 * Feature overview for the public landing (`/`). The section carries
 * `id="features"`, the anchor `PublicNav` links to, so the id is a contract
 * with the header and must not change on its own.
 */
export function FeatureGrid() {
  return (
    <section
      id="features"
      aria-labelledby={FEATURES_HEADING_ID}
      className="scroll-mt-20 border-b border-border-subtle px-4 py-16 lg:px-6 lg:py-20"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-10">
        <h2
          id={FEATURES_HEADING_ID}
          className="text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          Everything your listening deserves
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ title, description }) => (
            <li
              key={title}
              className="flex flex-col gap-2 rounded-card border border-border-subtle bg-surface-1 p-5"
            >
              <h3 className="text-base font-bold text-text-primary">{title}</h3>
              <p className="text-sm leading-relaxed text-text-secondary">
                {description}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
