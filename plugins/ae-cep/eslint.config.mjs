import { montajEslintConfig } from "@montaj/config/eslint";

import extendscriptConfig from "./eslint.extendscript.mjs";

export default montajEslintConfig({ browser: true, extra: extendscriptConfig });
