"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Menu, X } from "lucide-react";

interface SectionLink {
  href: string;
  label: string;
}

/**
 * On-page anchors for the public landing (`/`). The ids are the contract the
 * landing sections must carry (`id="features"`, `id="trending"`, ...), so
 * these links stay plain hash anchors — no routing, no client navigation.
 */
const SECTION_LINKS: SectionLink[] = [
  { href: "#features", label: "Features" },
  { href: "#trending", label: "Trending" },
  { href: "#reviews", label: "Reviews" },
  { href: "#lists", label: "Lists" },
];

const LINK_CLASS =
  "rounded px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary transition-colors hover:bg-surface-1 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda";

/**
 * Logged-out section navigation for `PublicHeader` — the only client
 * component in the public landing chrome. Inline links from `md` up; below
 * that, a disclosure button toggles a stacked panel of the same links.
 *
 * The toggle exposes its state through `aria-expanded`/`aria-controls`. The
 * panel stays mounted (so `aria-controls` always resolves) but carries the
 * `hidden` attribute while closed, which removes it from layout, the tab
 * order and the accessibility tree. Following a link closes it. The toggle
 * and the panel share a wrapper that listens for Escape, so it closes the
 * menu and returns focus to the toggle whether focus is still on the toggle
 * (immediately after opening) or has moved inside the panel — keyboard users
 * are never stranded inside a vanished panel.
 */
export function PublicNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !open) return;
    close();
    toggleRef.current?.focus();
  }

  return (
    <>
      <nav aria-label="Landing" className="hidden items-center gap-1 md:flex">
        {SECTION_LINKS.map(({ href, label }) => (
          <a key={href} href={href} className={LINK_CLASS}>
            {label}
          </a>
        ))}
      </nav>

      <div onKeyDown={onKeyDown} className="md:hidden">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((current) => !current)}
          className="rounded p-1.5 text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coda md:hidden"
        >
          {open ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </button>

        <nav
          id={panelId}
          aria-label="Landing mobile"
          hidden={!open}
          className="absolute inset-x-0 top-full flex flex-col gap-1 border-b border-border-subtle bg-background/95 px-4 py-3 backdrop-blur md:hidden"
        >
          {SECTION_LINKS.map(({ href, label }) => (
            <a key={href} href={href} onClick={close} className={LINK_CLASS}>
              {label}
            </a>
          ))}
        </nav>
      </div>
    </>
  );
}
