"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, BookOpen, ListOrdered, User } from "lucide-react";
import { cn } from "@coda/ui";

interface BottomNavProps {
  /** `/u/{username}` for a resolved viewer, degrading to `/home` (see AppShell). */
  youHref: string;
}

interface NavItem {
  href: string;
  label: string;
  Icon: typeof Home;
}

/**
 * Concept → real route mapping (confirmed against the actual app, not
 * invented): Home → `/home`, Search → `/search`, Diary → `/activity` (the
 * viewer's own activity — the closest existing concept to a personal diary),
 * Lists → `/lists` (the index built for this purpose), You → `/u/[username]`
 * (the same route serves public and own profile, keyed by the viewer's own
 * username).
 */
function navItems(youHref: string): NavItem[] {
  return [
    { href: "/home", label: "Home", Icon: Home },
    { href: "/search", label: "Search", Icon: Search },
    { href: "/activity", label: "Diary", Icon: BookOpen },
    { href: "/lists", label: "Lists", Icon: ListOrdered },
    { href: youHref, label: "You", Icon: User },
  ];
}

/**
 * Fixed bottom navigation for this milestone's routes (`/home`, `/feed`).
 * Client component only for `usePathname()`-driven active-state highlighting;
 * everything it needs to render (the viewer's own profile href) is resolved
 * server-side by {@link AppShell} and passed in as a prop.
 */
export function BottomNav({ youHref }: BottomNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-around border-t border-border-subtle bg-surface-1 px-2 py-2"
    >
      {navItems(youHref).map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-0.5 px-2 py-1 text-[10px] font-medium",
              active ? "text-coda" : "text-text-tertiary",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
