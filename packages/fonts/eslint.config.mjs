import { montajEslintConfig } from "@montaj/config/eslint";

export default montajEslintConfig({ browser: true, ignores: ["e2e/.artifacts/**", "pack/**"] });
