import { montajEslintConfig } from "@montaj/config/eslint";

export default montajEslintConfig({
  extra: [
    {
      // NestJS DTO classes rely on definite-assignment declarations, and the
      // decorator metadata is what makes DI and OpenAPI work.
      files: ["src/**/*.ts"],
      rules: { "@typescript-eslint/no-extraneous-class": "off" },
    },
  ],
});
