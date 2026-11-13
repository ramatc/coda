import type { MetadataRoute } from "next";

/** Matches `--color-background` (oklch(0.125 0.014 300)) as sRGB hex. */
const BACKGROUND = "#07060b";

/**
 * Web app manifest. Dark-first, like the app: background and theme color are
 * the archive background. The only raster icons today are the 326×322 app
 * icon PNGs, declared with their real size; square 192/512 icons follow once
 * the logo exists as SVG.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Coda",
    short_name: "Coda",
    description: "Track, rate, and review the music you love.",
    start_url: "/",
    display: "standalone",
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [{ src: "/icon.png", sizes: "326x322", type: "image/png" }],
  };
}
