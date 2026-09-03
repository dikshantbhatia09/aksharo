// Shared ESLint flat config for every TypeScript workspace in the monorepo.
// Consume from a package with:
//
//   import { montajEslintConfig } from "@montaj/config/eslint";
//   export default montajEslintConfig();
//
// Type-aware rules are deliberately off: `pnpm typecheck` owns type errors and
// keeping lint project-less makes it fast and independent of build order.
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import securityPlugin from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Paths no package should ever lint. */
export const globalIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.venv/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/*.d.ts",
  "**/generated/**",
];

const importOrder = {
  "import/order": [
    "error",
    {
      groups: ["builtin", "external", "internal", ["parent", "sibling", "index"], "type"],
      pathGroups: [{ pattern: "@montaj/**", group: "internal", position: "before" }],
      pathGroupsExcludedImportTypes: ["builtin"],
      "newlines-between": "always",
      alphabetize: { order: "asc", caseInsensitive: true },
    },
  ],
  "import/no-duplicates": "error",
  "import/newline-after-import": "error",
  // TypeScript resolves modules; the plugin's own resolver would only duplicate
  // that work (and get workspace `exports` maps wrong).
  "import/no-unresolved": "off",
  "import/named": "off",
  "import/namespace": "off",
  "import/default": "off",
  "import/no-named-as-default-member": "off",
};

// `eslint-plugin-security`'s own `recommended` flat config ships every rule at
// "warn" (docs/security/threat-model-audit-2026-09-03.md follow-up: "add
// eslint-plugin-security ... scoped to apps/api/src"; applied repo-wide here
// instead so every workspace gets the same floor). C02c (2026-09-03) drove
// apps/api, apps/web, packages/bridge-core and apps/desktop to zero findings
// (one real ReDoS-shaped regex fixed, the rest reviewed and annotated) and
// promoted those four to "error" via a per-package `securityRulesStrict`
// override. M06 (2026-09-03) repeated that review for every remaining
// package — every finding across the rest of the monorepo was reviewed and
// confirmed a false positive of this plugin's known-noisy heuristics (bounded
// regexes flagged as "unsafe", enum-bounded bracket access flagged as
// "object injection", internal/manifest-driven paths flagged as "non-literal
// fs filename"; see the WP report for the rule-by-rule breakdown) and
// annotated with a reasoned `eslint-disable-next-line`. With the whole repo
// now at zero unreviewed findings, `securityRules` (still exported below for
// anything that references it) is promoted to "error" as the shared default
// instead of "warn" — no package needs the split any more.
export const securityRules = Object.fromEntries(
  Object.keys(securityPlugin.configs.recommended.rules).map((rule) => [rule, "error"]),
);

/** Kept as an alias of `securityRules` (now already "error" repo-wide) so a
 * package that still imports `securityRulesStrict` from before M06 does not
 * need an edit. Prefer `securityRules` in new code. */
export const securityRulesStrict = securityRules;

const unused = {
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      args: "after-used",
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  "no-unused-private-class-members": "error",
};

/**
 * @param {object} [options]
 * @param {string[]} [options.ignores] extra ignore globs for this package
 * @param {boolean} [options.browser] add DOM globals (web app, UI package, CanvasKit backend)
 * @param {import("eslint").Linter.Config[]} [options.extra] extra flat-config blocks appended last
 * @returns {import("eslint").Linter.Config[]}
 */
export function montajEslintConfig(options = {}) {
  const { ignores = [], extra = [], browser = false } = options;
  return [
    { ignores: [...globalIgnores, ...ignores] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx}"],
      plugins: { import: importPlugin, security: securityPlugin },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        globals: {
          ...globals.node,
          ...globals.es2024,
          ...(browser ? globals.browser : {}),
        },
      },
      rules: {
        ...importOrder,
        ...unused,
        ...securityRules,
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "inline-type-imports" },
        ],
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-non-null-assertion": "error",
        eqeqeq: ["error", "smart"],
        "no-console": ["warn", { allow: ["warn", "error"] }],
        "no-restricted-syntax": [
          "error",
          {
            selector: "TSEnumDeclaration[const=true]",
            message: "const enums break isolatedModules; use a union or an object literal.",
          },
        ],
      },
    },
    {
      // Tests, config files and scripts may log and use loose typing helpers.
      files: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "**/tests/**",
        "**/test/**",
        "**/scripts/**",
        "**/*.config.{ts,mts,cts,js,mjs,cjs}",
        "**/eslint.config.mjs",
      ],
      rules: {
        "no-console": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-non-null-assertion": "off",
      },
    },
    prettierConfig,
    ...extra,
  ];
}

export default montajEslintConfig();
