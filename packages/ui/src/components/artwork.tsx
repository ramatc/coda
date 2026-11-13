import type { ReactNode } from "react";
import { cn } from "../lib/cn";

type ArtworkSource =
  | {
      /** Plain image URL; rendered as an `<img>` covering the frame. */
      src: string;
      /** Required with `src`. Use `""` only when the title sits next to it. */
      alt: string;
      children?: never;
    }
  | {
      src?: never;
      alt?: never;
      /** An image element of your own (e.g. `next/image` with `fill`). */
      children?: ReactNode;
    };

export type ArtworkProps = ArtworkSource & {
  /** Width comes from the caller (e.g. `w-16`, `w-full`). */
  className?: string;
};

/**
 * Album artwork frame: square, 6px artwork radius, image covers the frame.
 * No tint, no shadow. With neither `src` nor children it shows an empty
 * surface placeholder.
 */
export function Artwork({ src, alt, children, className }: ArtworkProps) {
  return (
    <span
      className={cn(
        "relative block aspect-square overflow-hidden rounded-artwork bg-surface-2",
        className,
      )}
      data-testid="artwork"
    >
      {src !== undefined ? (
        <img
          src={src}
          alt={alt}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        children
      )}
    </span>
  );
}
