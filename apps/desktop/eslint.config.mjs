import { montajEslintConfig } from "@montaj/config/eslint";

export default montajEslintConfig({
  ignores: ["dist/**", "playwright-report/**", "test-results/**"],
});
