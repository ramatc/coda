import type { ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";
import { fetchViewerProfile } from "../../lib/lists";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Shared dark-first shell (Header + BottomNav) for this milestone's routes
 * (`/home`, `/feed`). Composed directly into each page rather than a new
 * route-group layout, so no route moves and no other page's behavior
 * changes — the smallest change that gets both pages under one shell.
 *
 * Resolves the viewer's own username via {@link fetchViewerProfile} (the same
 * `GET /profile`-backed helper `/lists` already uses) rather than Clerk's
 * `currentUser().username`: the app's `Profile.username` can diverge from (or
 * exist when Clerk's own username field doesn't — see `clerk-webhook.service`'s
 * fallback), so `/profile` is the only source that matches what `/u/[username]`
 * actually serves. A page that reaches this shell has already passed the
 * onboarding gate, so a `null` profile here is a transient blip, not a
 * legitimate "no profile" state — it degrades the "You" link to `/home`
 * rather than guessing a username that might not resolve.
 */
export async function AppShell({ children }: AppShellProps) {
  const { getToken } = await auth();
  const token = await getToken();
  const profile = await fetchViewerProfile(token);
  const youHref = profile ? `/u/${profile.username}` : "/home";
  const youInitial = profile ? profile.username.charAt(0).toUpperCase() : "?";

  return (
    <div className="flex min-h-screen flex-col">
      <Header youHref={youHref} youInitial={youInitial} />
      <div className="flex-1 pb-16">{children}</div>
      <BottomNav youHref={youHref} />
    </div>
  );
}
