import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

const TENANCY_MESSAGE =
  "Tenant isolation: raw collections may only be used inside src/db, src/repositories and src/scripts. Use createRepositories().forTenant(...).";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "widget"] }, // widget/ is browser code, shipped separately from the API
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Application code (routes, services, AI tools) must reach data only through tenant-bound repositories.
    files: ["src/**/*.ts"],
    ignores: ["src/db/**", "src/repositories/**", "src/scripts/**", "src/domain/**", "src/server.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.property.name='collection']", message: TENANCY_MESSAGE },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/db/collections.js", "**/db/scopedCollection.js", "mongodb"], message: TENANCY_MESSAGE }] },
      ],
    },
  },
);
