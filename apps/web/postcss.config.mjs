/**
 * PostCSS config for Tailwind 4 (CSS-first). The Tailwind plugin reads the
 * `@theme` tokens declared in `app/globals.css` and the shared
 * `@coda/config/tailwind/preset.css` at build time.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
