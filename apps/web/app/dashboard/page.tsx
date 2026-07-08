import { auth } from "@clerk/nextjs/server";

/**
 * Placeholder PROTECTED route. The middleware redirects unauthenticated
 * visitors to sign-in before this renders, so reaching it means a session
 * exists. Fase 0 only proves the wiring — it shows the Clerk `userId` and a
 * banner, with no real dashboard UI.
 */
export default async function DashboardPage() {
  const { userId } = await auth();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <div className="rounded-card border border-brand-600 bg-brand-50 px-4 py-3 text-brand-900">
        This is a protected route — you are signed in.
      </div>
      <p className="text-sm opacity-70">
        Clerk user id: <code>{userId}</code>
      </p>
    </main>
  );
}
