import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // `module` is the established domain name for ship equipment definitions.
      "@next/next/no-assign-module-variable": "off",
      // Editors and LocalStorage hydration intentionally synchronize draft state in effects.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".pytest_cache/**",
    "backend/.pytest_cache/**",
    ".pnpm-store/**",
    "work/**",
    "outputs/**",
    "logs/**",
  ]),
]);

export default eslintConfig;
