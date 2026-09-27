import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dark } from "@clerk/ui/themes";
import { clerkAppearance } from "../lib/clerk-appearance";

const presetCss = readFileSync(
  new URL(
    "../../../packages/config/tailwind/preset.css",
    import.meta.url,
  ),
  "utf8",
);

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
    expect(clerkAppearance.variables).toEqual({
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

  /**
   * The mapping above can't catch a token that was renamed or removed in the
   * preset: `var(--missing)` is valid CSS and fails silently in the browser.
   */
  it("only references tokens declared in the shared preset", () => {
    const tokens = Object.values(clerkAppearance.variables).flatMap(
      (value) => /^var\((--[\w-]+)\)$/.exec(value)?.[1] ?? [],
    );

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(presetCss, `${token} missing from preset.css`).toMatch(
        new RegExp(`^\\s*${token}:`, "m"),
      );
    }
  });
});
