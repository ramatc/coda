import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coda",
  description: "Track, rate, and review the music you love.",
};

/**
 * Root layout. Wraps the whole tree in `<ClerkProvider>` so Clerk's auth
 * context is available to every route (including the placeholder protected
 * `/dashboard` route). Fase 0 wires the provider only — no sign-in/up UI yet.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
