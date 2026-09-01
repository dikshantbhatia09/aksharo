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
      plugins: { import: importPlugin },
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
