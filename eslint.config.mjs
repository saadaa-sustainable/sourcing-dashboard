import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Deno edge functions run on a different runtime (Deno globals, esm.sh
    // imports) and are NOT part of the Next.js app — linting them with this
    // config produced 12 spurious no-explicit-any errors. They are type-checked
    // by Deno, not by `npm run lint`.
    "supabase/functions/**",
    // One-off Node backfill scripts, also outside the app's tsconfig scope.
    "backfill/**",
  ]),
]);

export default eslintConfig;
