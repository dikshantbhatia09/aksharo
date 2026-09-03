/**
 * Automatic checks for `edit-plan@1` (mirrors `checks.ts`'s role for the
 * insight templates): schema validity, then the guardrail check
 * (`validateEditPlan` — only known pass kinds/params, budget caps, engine
 * allowlist, rationale-per-pass) that stands in for this template's
 * hallucination guard, since a plan has no free prose to check against a
 * transcript vocabulary.
 */
import { editPlanTemplate, validateEditPlan } from "../templates/edit-plan.js";

import type { CheckResult } from "./checks.js";
import type { EditPlanInput } from "../templates/edit-plan.js";

export function runEditPlanChecks(input: EditPlanInput, output: unknown): readonly CheckResult[] {
  const schemaResult = editPlanTemplate.outputSchema.safeParse(output);
  const schemaCheck: CheckResult = {
    name: "schema_validity",
    ok: schemaResult.success,
    detail: schemaResult.success
      ? "output matches EditPlanOutputSchema"
      : (schemaResult.error?.message ?? "invalid"),
  };
  if (!schemaResult.success) return [schemaCheck];

  const violations = validateEditPlan(schemaResult.data, input);
  const guardrailCheck: CheckResult = {
    name: "guardrail_validity",
    ok: violations.length === 0,
    detail:
      violations.length === 0
        ? "only known pass kinds/params, within budget, engine tier allowed"
        : violations.map((v) => `${v.code}: ${v.detail}`).join("; "),
  };

  const nonEmptyPasses: CheckResult = {
    name: "non_empty_plan",
    ok: schemaResult.data.passes.length > 0,
    detail:
      schemaResult.data.passes.length > 0
        ? `${String(schemaResult.data.passes.length)} pass(es) proposed`
        : "no passes proposed",
  };

  return [schemaCheck, guardrailCheck, nonEmptyPasses];
}
