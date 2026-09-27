import { describe, expect, it, vi } from "vitest";

const { ClerkProvider } = vi.hoisted(() => ({
  ClerkProvider: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({ ClerkProvider }));
vi.mock("next/font/google", () => ({
  Inter_Tight: () => ({ variable: "font-inter-tight" }),
  Source_Serif_4: () => ({ variable: "font-source-serif" }),
}));

import RootLayout from "../app/layout";
import { clerkAppearance } from "../lib/clerk-appearance";
import {
  SIGN_IN_FALLBACK_REDIRECT_URL,
  SIGN_IN_URL,
  SIGN_UP_FALLBACK_REDIRECT_URL,
  SIGN_UP_URL,
} from "../lib/auth-routes";

/**
 * `<ClerkProvider>` is the one place the client-side Clerk components learn
 * the app theme, the in-app auth routes, and where to land after auth. A
 * dropped prop falls back silently to Clerk's defaults (white card, hosted
 * Account Portal), so the wiring is asserted on the element the layout
 * returns rather than by rendering `<html>` into a test DOM.
 */
describe("RootLayout", () => {
  it("wraps the tree in ClerkProvider with the app's auth wiring", () => {
    const tree = RootLayout({ children: <p>child</p> });

    expect(tree.type).toBe(ClerkProvider);
    expect(tree.props).toMatchObject({
      appearance: clerkAppearance,
      signInUrl: SIGN_IN_URL,
      signUpUrl: SIGN_UP_URL,
      signInFallbackRedirectUrl: SIGN_IN_FALLBACK_REDIRECT_URL,
      signUpFallbackRedirectUrl: SIGN_UP_FALLBACK_REDIRECT_URL,
    });
  });

  it("points the auth routes at the in-app pages", () => {
    expect([SIGN_IN_URL, SIGN_UP_URL]).toEqual(["/sign-in", "/sign-up"]);
    expect(SIGN_IN_FALLBACK_REDIRECT_URL).toBe("/home");
    expect(SIGN_UP_FALLBACK_REDIRECT_URL).toBe("/onboarding");
  });
});
