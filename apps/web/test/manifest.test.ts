import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";

describe("manifest", () => {
  it("describes Coda as a dark-first standalone app", () => {
    const result = manifest();

    expect(result.name).toBe("Coda");
    expect(result.start_url).toBe("/");
    expect(result.display).toBe("standalone");
    expect(result.background_color).toBe("#07060b");
    expect(result.theme_color).toBe("#07060b");
  });

  it("declares the app icon with its real size", () => {
    expect(manifest().icons).toEqual([
      { src: "/icon.png", sizes: "326x322", type: "image/png" },
    ]);
  });
});
