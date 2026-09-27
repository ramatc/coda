import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter_Tight, Source_Serif_4 } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coda",
  description: "Track, rate, and review the music you love.",
};

// UI/product chrome, navigation, titles, metadata, ratings — binds
// `--font-inter-tight`, read by the shared preset's `--font-sans` token.
const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

// Reviews and human opinion only — binds `--font-source-serif`, read by the
// shared preset's `--font-serif` token. Never used for UI chrome or data.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});

/**
 * Root layout. Wraps the whole tree in `<ClerkProvider>` so Clerk's auth
 * context is available to every route (including the protected `/home`,
 * `/dashboard`, etc. routes gated by `middleware.ts`).
 *
 * `signInUrl`/`signUpUrl` point Clerk's client-side components and links
 * (e.g. `<SignInButton>`, the "Sign up" link inside `<SignIn />`) at this
 * app's own `/sign-in` and `/sign-up` routes instead of Clerk's hosted
 * Account Portal. The server-side `auth.protect()` redirect does NOT read
 * these props — `middleware.ts` sets the same URLs for it. These are the
 * in-app pages the landing links
 * (`hero.tsx`, `public-header.tsx`, `final-cta.tsx`) already point to.
 * `signInFallbackRedirectUrl`/`signUpFallbackRedirectUrl` are Clerk's actual
 * v7 prop names for "where to land when nothing more specific (like a
 * `redirect_url` query param) applies": `/home` after sign-in (the
 * onboarding gate there redirects unonboarded users to `/onboarding` itself),
 * and `/onboarding` directly after sign-up, since a brand-new account has
 * never completed it. These are set in code, not env vars, so they're
 * reviewable here alongside the routes they target.
 *
 * Dark-first is the app's identity, applied here at the root rather than
 * scoped to a subset of routes: `bg-background`/`text-text-primary` cover
 * every page. Screens not yet migrated off the legacy `brand-*` tokens (search,
 * albums, lists, profiles, reviews) keep their own explicit colors and are
 * unaffected functionally, but will look visually inconsistent against the new
 * background until their own migration pass.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/home"
      signUpFallbackRedirectUrl="/onboarding"
    >
      <html
        lang="en"
        className={`${interTight.variable} ${sourceSerif.variable}`}
      >
        <body className="bg-background font-sans text-text-primary">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
