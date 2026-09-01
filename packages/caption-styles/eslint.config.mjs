import { montajEslintConfig } from "@montaj/config/eslint";

// `.tmp/` holds scratch files that are not part of the package.
export default montajEslintConfig({ ignores: [".tmp/**"] });
