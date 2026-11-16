import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const presetCss = readFileSync(
  new URL("../../../packages/config/tailwind/preset.css", import.meta.url),
  "utf8",
);

/**
 * Brand Kit v1.2 §33: motion is short, precise and functional, and respects
 * `prefers-reduced-motion`. The kit gives no numbers, so the preset owns them.
 */
describe("motion tokens", () => {
  it.each([
    "--motion-fast",
    "--motion-base",
    "--motion-slow",
    "--ease-out",
    "--default-transition-duration",
    "--default-transition-timing-function",
    "--animate-enter",
  ])("defines %s", (token) => {
    expect(presetCss).toMatch(new RegExp(`^\\s*${token}:`, "m"));
  });

  it("disables animations and transitions under reduced motion", () => {
    const block = presetCss.split("@media (prefers-reduced-motion: reduce)")[1];

    expect(block, "reduced-motion block missing").toBeDefined();
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
  });

  it("never uses bounce or elastic curves", () => {
    expect(presetCss).not.toMatch(/cubic-bezier\([^)]*-\d|[^.\d]1\.\d+\)/);
  });
});
