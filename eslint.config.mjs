import { defineConfig, globalIgnores } from "eslint/config";

// Minimal post-Next ESLint config. The Next-specific rule packs (image,
// link, web-vitals) no longer apply after the Vite migration. tsc covers
// most of what eslint-config-next caught for us; this config exists so
// `bun run lint` doesn't error out, and leaves room to layer in
// typescript-eslint later if linting becomes load-bearing.
export default defineConfig([
  globalIgnores([
    "dist/**",
    "out/**",
    "build/**",
    "node_modules/**",
    "src-tauri/target/**",
    "src/routeTree.gen.ts",
  ]),
  {
    rules: {
      "no-unused-vars": "off",
    },
  },
]);
