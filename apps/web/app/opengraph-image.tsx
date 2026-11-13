import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Coda — your after-hours music archive";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/*
 * Brand colors as sRGB hex: Satori (next/og) does not parse oklch(). Each value
 * is the conversion of the matching token in `@coda/config/tailwind/preset.css`.
 */
const BACKGROUND = "#07060b";
const SURFACE = "#0f0d15";
const BORDER = "#26222d";
const TEXT_PRIMARY = "#f4efe9";
const TEXT_SECONDARY = "#a9a8b4";
const CODA = "#8c4fff";

/**
 * Site-wide Open Graph image: the monogram, the wordmark and the tagline on
 * the dark archive background. No glow, gradient or shadow. Pages with their
 * own image (album covers) override it.
 */
export default async function OpengraphImage() {
  const monogram = await readFile(
    join(process.cwd(), "public/brand/coda-monogram.png"),
  );
  const monogramSrc = `data:image/png;base64,${monogram.toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        background: BACKGROUND,
        color: TEXT_PRIMARY,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <img src={monogramSrc} width={88} height={88} alt="" />
        <span style={{ fontSize: 56, fontWeight: 800, letterSpacing: 4 }}>
          CODA
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <span
          style={{
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: CODA,
          }}
        >
          The listener&apos;s diary
        </span>
        <span style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05 }}>
          Your after-hours music archive.
        </span>
        <span style={{ fontSize: 30, color: TEXT_SECONDARY }}>
          Rate every album 1–10, write the review it deserves, keep the lists.
        </span>
      </div>
      {/* The rating scale motif: ten segments, nine filled (a personal 9). */}
      <div style={{ display: "flex", gap: 8 }}>
        {Array.from({ length: 10 }, (_, index) => (
          <div
            key={index}
            style={{
              width: 14,
              height: 44,
              borderRadius: 2,
              background: index < 9 ? CODA : SURFACE,
              border: index < 9 ? "none" : `1px solid ${BORDER}`,
            }}
          />
        ))}
      </div>
    </div>,
    size,
  );
}
