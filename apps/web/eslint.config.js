import react from "@coda/config/eslint/react.js";

export default [
  ...react,
  {
    ignores: ["**/.next/**", "next-env.d.ts"],
  },
];
