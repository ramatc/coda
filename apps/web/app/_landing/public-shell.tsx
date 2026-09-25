import type { ReactNode } from "react";
import { PublicHeader } from "./public-header";
import { PublicFooter } from "./public-footer";

interface PublicShellProps {
  children: ReactNode;
}

/**
 * Logged-out peer of `AppShell` for the public landing (`/`): the same
 * `flex min-h-screen flex-col` frame, with {@link PublicHeader} on top and
 * {@link PublicFooter} pinned to the bottom of short pages.
 *
 * Unlike `AppShell` it is synchronous and resolves no viewer — there is no
 * `auth()` call and no bottom nav — so the landing renders identically for
 * anonymous and signed-in visitors. The page content is wrapped in the
 * `<main>` landmark here, so pages composed inside this shell must not add
 * their own.
 */
export function PublicShell({ children }: PublicShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
