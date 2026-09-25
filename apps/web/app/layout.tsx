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
 * context is available to every route (including the placeholder protected
 * `/dashboard` route).
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
    <ClerkProvider>
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
