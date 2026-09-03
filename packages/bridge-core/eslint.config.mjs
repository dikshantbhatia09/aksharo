import { montajEslintConfig, securityRulesStrict } from "@montaj/config/eslint";

export default montajEslintConfig({
  extra: [
    // C02c (2026-09-03): every eslint-plugin-security finding here is fixed or
    // annotated (docs/security/threat-model-audit-2026-09-03.md follow-up) —
    // promoted to "error" so a new one fails lint instead of sitting at warn.
    { rules: securityRulesStrict },
  ],
});
