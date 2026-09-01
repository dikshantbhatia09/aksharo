/**
 * Shared Prettier configuration.
 * Consume from a package or the repo root with:
 *   export { default } from "@montaj/config/prettier";
 *
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [
    { files: ["*.md"], options: { proseWrap: "preserve" } },
    { files: ["*.yml", "*.yaml"], options: { singleQuote: false } },
    { files: ["*.json"], options: { printWidth: 120 } },
  ],
};

export default config;
