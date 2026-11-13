import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { AppShell } from "../_shell/app-shell";

/**
 * Placeholder PROTECTED route. The middleware redirects unauthenticated
 * visitors to sign-in before this renders, so reaching it means a session
 * exists. Also enforces the onboarding gate (same as `/home`) so a signed-in
 * but unonboarded user cannot reach this page directly and skip the flow.
 * Fase 0 only proves the wiring — it shows the Clerk `userId` and a banner,
 * with no real dashboard UI.
 */
export default async function DashboardPage() {
  const { userId, getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/dashboard");
  if (redirectTo) {
    redirect(redirectTo);
  }

  return await AppShell({
    children: (
      <main className="mx-auto flex max-w-2xl flex-col justify-center gap-4 px-6">
        <div className="rounded-card border border-border-subtle bg-surface-1 px-4 py-3 text-text-primary">
          This is a protected route — you are signed in.
        </div>
        <p className="text-sm opacity-70">
          Clerk user id: <code>{userId}</code>
        </p>
      </main>
    ),
  });
}
