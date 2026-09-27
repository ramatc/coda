import { dark } from "@clerk/ui/themes";

/**
 * App-wide `appearance` for every Clerk component, passed once to
 * `<ClerkProvider>` in `app/layout.tsx`.
 *
 * Clerk's default theme is a white card, which clashes with the dark-first
 * shell the in-app `/sign-in` and `/sign-up` routes render in. `dark` is the
 * base; `variables` then point Clerk at the shared design tokens (declared in
 * `@coda/config/tailwind/preset.css`) through CSS variables, so the widgets
 * follow any future token change instead of pinning a copied color.
 *
 * Core 3 note: themes come from `@clerk/ui/themes` and the key is `theme` —
 * the older `@clerk/themes` package and `baseTheme` key target Clerk Core 2.
 */
export const clerkAppearance = {
  theme: dark,
  variables: {
    colorPrimary: "var(--color-coda)",
    // Same pairing as the landing's `bg-coda text-white` CTAs.
    colorPrimaryForeground: "white",
    colorBackground: "var(--color-surface-1)",
    colorForeground: "var(--color-text-primary)",
    colorMutedForeground: "var(--color-text-secondary)",
    colorInput: "var(--color-surface-2)",
    colorInputForeground: "var(--color-text-primary)",
    colorBorder: "var(--color-border-subtle)",
  },
};
