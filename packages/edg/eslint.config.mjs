import { montajEslintConfig } from "@montaj/config/eslint";

// `.tmp/` holds scratch files written by the export-resolution test.
export default montajEslintConfig({ ignores: [".tmp/**"] });
