import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import base from "./base.js";

/**
 * React variant of the shared ESLint config. Extends the base TypeScript
 * config with browser globals and the React Hooks rules. Used by `@coda/ui`
 * and `apps/web`.
 */
export default [
  ...base,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
