import { montajEslintConfig, securityRulesStrict } from "@montaj/config/eslint";

export default montajEslintConfig({
  // `pnpm gen:client` compiles the app here before running the generator; it is
  // build output, not source.
  ignores: [".openapi/**"],
  extra: [
    // C02c (2026-09-03): every eslint-plugin-security finding here is fixed or
    // annotated (docs/security/threat-model-audit-2026-09-03.md follow-up) —
    // promoted to "error" so a new one fails lint instead of sitting at warn.
    { rules: securityRulesStrict },
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
