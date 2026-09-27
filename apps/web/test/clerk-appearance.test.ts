import { describe, expect, it } from "vitest";
import { dark } from "@clerk/ui/themes";
import { clerkAppearance } from "../lib/clerk-appearance";

/**
 * The Clerk widgets (`/sign-in`, `/sign-up`) render inside the app's
 * dark-first shell; without a dark base theme they show Clerk's default white
 * card on top of `bg-background`.
 */
describe("clerkAppearance", () => {
  it("builds on Clerk's dark theme", () => {
    expect(clerkAppearance.theme).toBe(dark);
  });

  it("maps Clerk's variables onto the shared design tokens", () => {
    expect(clerkAppearance.variables).toMatchObject({
      colorPrimary: "var(--color-coda)",
      // Matches the landing's `bg-coda text-white` buttons.
      colorPrimaryForeground: "white",
      colorBackground: "var(--color-surface-1)",
      colorForeground: "var(--color-text-primary)",
      colorMutedForeground: "var(--color-text-secondary)",
      colorInput: "var(--color-surface-2)",
      colorInputForeground: "var(--color-text-primary)",
      colorBorder: "var(--color-border-subtle)",
    });
  });
});
