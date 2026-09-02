import { montajEslintConfig } from "@montaj/config/eslint";

// The executor and the surface helpers touch DOM types (HTMLCanvasElement,
// WebGL), so this package lints with browser globals.
export default montajEslintConfig({
  browser: true,
  ignores: ["e2e/.artifacts/**"],
  // The e2e harness is a build tool and a static server: telling the operator
  // what it did is the whole output.
  extra: [{ files: ["e2e/*.mjs"], rules: { "no-console": "off" } }],
});
