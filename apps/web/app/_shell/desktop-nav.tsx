"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@coda/ui";

interface NavItem {
  href: string;
  label: string;
}

/** Same concept → route mapping as `BottomNav`, minus "You" (the avatar already covers it). */
const NAV_ITEMS: NavItem[] = [
  { href: "/home", label: "Home" },
  { href: "/search", label: "Search" },
  { href: "/activity", label: "Diary" },
  { href: "/lists", label: "Lists" },
];

/**
 * Inline desktop navigation shown in the header from `lg` up, replacing
 * `BottomNav`'s job on wide viewports (see `AppShell`, which hides `BottomNav`
 * at `lg`). Client component only for `usePathname()`-driven active-state
 * highlighting, same reasoning as `BottomNav` itself.
 */
export function DesktopNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary desktop"
      className="hidden items-center gap-1 lg:flex"
    >
      {NAV_ITEMS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors",
              active
                ? "bg-surface-2 text-text-primary"
                : "text-text-secondary hover:bg-surface-1 hover:text-text-primary",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
