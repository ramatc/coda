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

  /**
   * Asserts the invariant instead of mirroring the config: every color reads
   * a design token through `var(--…)`, and that token actually exists in the
   * shared preset — a renamed or misspelled token would otherwise fail
   * silently in the browser.
   */
  it("reads every color from a token declared in the shared preset", () => {
    // Same pairing as the landing's `bg-coda text-white` CTAs, not a token.
    const { colorPrimaryForeground, ...tokenBacked } =
      clerkAppearance.variables;
    expect(colorPrimaryForeground).toBe("white");

    for (const [key, value] of Object.entries(tokenBacked)) {
      const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(token, `${key} must be a var(--token)`).toBeDefined();
      expect(presetCss, `${token} missing from preset.css`).toMatch(
        new RegExp(`^\\s*${token}:`, "m"),
      );
    }
  });
});
