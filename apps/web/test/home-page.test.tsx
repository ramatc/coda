import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomePage from "../app/page";

/**
 * Smoke test: the public landing page renders to static HTML without throwing.
 * This also exercises real workspace resolution of `@coda/ui` (the Button) and
 * `@coda/types`, catching packaging/resolution gaps a typecheck alone misses.
 */
describe("HomePage", () => {
  it("renders to static markup without runtime errors", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("Coda");
    expect(html).toContain("Get started");
  });
});
