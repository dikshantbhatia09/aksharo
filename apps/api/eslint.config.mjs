import { montajEslintConfig } from "@montaj/config/eslint";

export default montajEslintConfig({
  extra: [
    {
      // NestJS DTO classes rely on definite-assignment declarations, and the
      // decorator metadata is what makes DI and OpenAPI work.
      files: ["src/**/*.ts"],
      rules: {
        "@typescript-eslint/no-extraneous-class": "off",
        // A constructor parameter's type IS the DI token: NestJS resolves it from
        // the `design:paramtypes` metadata TypeScript emits, and `import type`
        // erases that to `Object`, so the provider silently fails to resolve.
        // Off for `src/` (the DI surface) and on everywhere else.
        "@typescript-eslint/consistent-type-imports": "off",
      },
    },
  ],
});
