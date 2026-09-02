import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { findUnauditedControllers } from "./audited-routes.scan.js";

/**
 * The audit-completeness contract test (B16 brief §3), tagged clearly per
 * the brief's own instruction — **this is the test B13 will reuse** — so a
 * later work package finds it by name rather than by re-deriving the same
 * check. See `audited-routes.scan.ts` for exactly what "audited" means here
 * and its limits.
 */
describe("audit completeness — every mutating controller references an audit writer", () => {
  it("has no controller with a Post/Put/Patch/Delete route and zero audit-writer references", () => {
    const srcRoot = resolve(__dirname, "..");
    const violations = findUnauditedControllers(srcRoot);

    if (violations.length > 0) {
      const list = violations.map((v) => `  - ${v.file}`).join("\n");
      throw new Error(
        `${String(violations.length)} controller(s) declare a mutating route but never ` +
          `reference an audit writer (CommonAuditService/AuditService/AuthAuditService/` +
          `@Audited). Add the audit call, or add the file to EXEMPT_FILES in ` +
          `audited-routes.scan.ts with why:\n${list}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
