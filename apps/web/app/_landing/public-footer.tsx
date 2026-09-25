interface FooterLink {
  href: string;
  label: string;
}

/**
 * Informational links for the public landing. None of these destinations
 * exist yet, so every target is a `#` placeholder (accepted scope for this
 * change); swap each `href` for the real page once it ships.
 */
const FOOTER_LINKS: FooterLink[] = [
  { href: "#", label: "About" },
  { href: "#", label: "Community Guidelines" },
  { href: "#", label: "Privacy" },
  { href: "#", label: "Terms" },
  { href: "#", label: "Contact" },
  { href: "#", label: "GitHub" },
];

/**
 * Site-wide footer for the public landing (`/`), in the same editorial
 * register as the onboarding footer: mono type, tertiary text on the
 * background surface, a subtle top rule. Plain anchors rather than
 * `next/link` because every target is a same-page placeholder.
 */
export function PublicFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border-subtle bg-background py-8">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-6 px-4 font-mono text-[11px] text-text-tertiary lg:flex-row lg:items-center lg:justify-between lg:px-6">
        <div className="flex flex-col gap-1">
          <span className="font-bold text-text-primary">Coda Archive</span>
          <span>Nocturnal music diary &amp; social curation</span>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {FOOTER_LINKS.map(({ href, label }) => (
              <li key={label}>
                <a
                  href={href}
                  className="uppercase tracking-wide text-text-secondary transition-colors hover:text-text-primary"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <span>&copy; {year} Coda</span>
      </div>
    </footer>
  );
}
