/**
 * Lint, existing for one rule in particular.
 *
 * This repo had no linter at all. Typecheck cannot see the Rules of Hooks, so a
 * `useMemo` placed below an early return passed every check the project had and
 * shipped — it crashed the tournament screen on the exact click that starts a
 * match, which made every tournament unplayable in production.
 *
 * `react-hooks/rules-of-hooks` catches that class outright, at the moment it is
 * typed. Everything else here is deliberately quiet: a linter that floods a
 * codebase with style complaints on day one gets switched off, and then the one
 * rule that actually prevents outages goes with it. Correctness rules are
 * errors; taste is not configured.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/generated/**",
      "packages/db/prisma/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The reason this file exists.
      "react-hooks/rules-of-hooks": "error",
      // A stale closure is a real bug, but every existing violation would have
      // to be triaged before the gate could pass. Warn now, promote later.
      "react-hooks/exhaustive-deps": "warn",

      // Off: noisy on a codebase written without them, and none of these
      // describe a defect that reaches a user.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Tools are scripts: console output is the point, and they run under tsx.
    files: ["tools/**/*.ts", "**/*.config.*"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  }
);
