import { SignUp } from "@clerk/nextjs";

/**
 * In-app sign-up route (`/sign-up`, plus Clerk's own sub-paths such as
 * `/sign-up/verify-email-address` — hence the optional catch-all segment).
 * Landing links (`hero.tsx`, `public-header.tsx`, `final-cta.tsx`) and
 * `signUpUrl` on `<ClerkProvider>` (`app/layout.tsx`) both point here,
 * replacing Clerk's hosted Account Portal with a branded page that lives in
 * the app's own dark shell instead of navigating away to a
 * `*.accounts.dev` domain.
 *
 * `<SignUp />` renders unstyled against the root layout's
 * `bg-background text-text-primary`; centering it here (rather than in the
 * layout) keeps that concern local to this route, matching `/sign-in`.
 */
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <SignUp />
    </main>
  );
}
