import { SignIn } from "@clerk/nextjs";

/**
 * In-app sign-in route (`/sign-in`, plus Clerk's own sub-paths such as
 * `/sign-in/factor-one` for multi-factor and `/sign-in/sso-callback` for
 * OAuth — hence the optional catch-all segment). Landing links
 * (`public-header.tsx`, `final-cta.tsx`) and `signInUrl` on `<ClerkProvider>`
 * (`app/layout.tsx`) both point here, replacing Clerk's hosted Account
 * Portal with a branded page that lives in the app's own dark shell instead
 * of navigating away to a `*.accounts.dev` domain.
 *
 * `<SignIn />` is themed app-wide by `clerkAppearance`
 * (`lib/clerk-appearance.ts`, applied on `<ClerkProvider>`); centering it
 * here (rather than in the layout) keeps that concern local to this route,
 * matching `/sign-up`.
 */
export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <SignIn />
    </main>
  );
}
