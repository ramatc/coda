import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default scale. Without this, custom
 * font-size tokens like `text-body` would be treated as colors and dropped
 * when merged with `text-text-primary` (and vice versa).
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "display-xl",
        "display",
        "h1",
        "h2",
        "h3",
        "body-lg",
        "body",
        "small",
        "archive",
      ],
      radius: ["artwork", "control", "panel", "card"],
      shadow: ["floating"],
    },
  },
});

/**
 * Merge conditional class names and resolve Tailwind conflicts.
 * The canonical shadcn-style helper used by every Coda UI component.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
