import { montajEslintConfig } from "@montaj/config/eslint";

export default montajEslintConfig({
  browser: true,
  ignores: [".next/**", ".next-*/**", "next-env.d.ts"],
  extra: [
    {
      files: ["e2e/**/*.ts", "playwright.config.ts"],
      rules: { "no-console": "off" },
    },
  ],
});
