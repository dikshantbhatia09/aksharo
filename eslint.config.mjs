import { montajEslintConfig } from "@montaj/config/eslint";

// Root config: only repo-level scripts and config files live here. Every app and
// package owns its own eslint.config.mjs so `turbo run lint` can cache per package.
export default montajEslintConfig({
  ignores: ["apps/**", "packages/**", "plugins/**", "engine/**", "infra/**"],
});
