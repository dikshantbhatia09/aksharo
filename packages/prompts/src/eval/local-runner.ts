/**
 * `pnpm --filter @montaj/prompts eval:local`: the same fixtures/checks
 * `runner.ts`'s `run()` uses against the mock provider, run once against a
 * real local Ollama server (`generateWithOllama`). Deliberately separate
 * from `runner.ts`/`cli.ts` — that CI-critical path must never touch a
 * network — so nothing here is imported by `eval`/CI.
 */
import { runChecks } from "./checks.js";
import { runEditPlanChecks } from "./edit-plan-checks.js";
import { EDIT_PLAN_FIXTURES } from "./edit-plan-fixtures.js";
import { FIXTURES } from "./fixtures.js";
import {
  generateWithOllama,
  isOllamaReachable,
  ollamaBaseUrl,
  ollamaModel,
} from "./ollama-provider.js";
import { normalizeEditPlanOutput, normalizeInsightOutput } from "./small-model-normalize.js";
import { EDIT_PLAN_TEMPLATE_VERSION, editPlanTemplate } from "../templates/edit-plan.js";
import { INSIGHT_KINDS, templateFor } from "../templates/registry.js";

import type { CheckResult } from "./checks.js";
import type { EditPlanFixture } from "./edit-plan-fixtures.js";
import type { Fixture } from "./fixtures.js";
import type { InsightKind } from "../templates/registry.js";

export interface LocalEvalCase {
  readonly fixtureId: string;
  readonly kind: InsightKind | "edit-plan";
  readonly templateVersion: string;
  readonly latencyMs: number | null;
  readonly checks: readonly CheckResult[];
  readonly ok: boolean;
  /** Set when the call itself failed (network / all-attempts-invalid), not a check. */
  readonly error?: string;
}

export interface LocalEvalReport {
  readonly generatedAt: string;
  readonly provider: "ollama";
  readonly baseUrl: string;
  readonly model: string;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly cases: readonly LocalEvalCase[];
  readonly totalCases: number;
  readonly failedCases: number;
  readonly ok: boolean;
}

/**
 * Runs every insight template (`chapters`/`summary`/`hooks`) over
 * `fixtures`, and the edit-plan template over `editPlanFixtures`, against a
 * real Ollama server — one call each, no retries beyond the built-in
 * one-repair-on-invalid-JSON. Returns `{skipped: true}` with no cases when
 * Ollama is not reachable, so this is safe to run unconditionally in a dev
 * loop or CI without a local model.
 */
export async function runLocal(
  fixtures: readonly Fixture[] = FIXTURES,
  editPlanFixtures: readonly EditPlanFixture[] = EDIT_PLAN_FIXTURES,
): Promise<LocalEvalReport> {
  const baseUrl = ollamaBaseUrl();
  const model = ollamaModel();
  const reachable = await isOllamaReachable(baseUrl);
  if (!reachable) {
    return {
      generatedAt: new Date().toISOString(),
      provider: "ollama",
      baseUrl,
      model,
      skipped: true,
      skipReason: `no Ollama server reachable at ${baseUrl} — run "ollama serve" and "ollama pull ${model}" to enable eval:local`,
      cases: [],
      totalCases: 0,
      failedCases: 0,
      ok: true,
    };
  }

  const cases: LocalEvalCase[] = [];
  for (const fixture of fixtures) {
    for (const kind of INSIGHT_KINDS) {
      const template = templateFor(kind);
      const input = { ...fixture.transcript, ...(kind === "hooks" ? { tone: "energetic" } : {}) };
      const parsedInput: unknown = template.inputSchema.parse(input);
      try {
        const { output, latencyMs } = await generateWithOllama(template, parsedInput, {
          baseUrl,
          model,
          normalize: (raw) => normalizeInsightOutput(kind, raw),
        });
        const checks = runChecks(kind, template.outputSchema, output, fixture.transcript);
        const ok = checks.every((c) => c.ok);
        cases.push({
          fixtureId: fixture.id,
          kind,
          templateVersion: template.version,
          latencyMs,
          checks,
          ok,
        });
      } catch (error) {
        cases.push({
          fixtureId: fixture.id,
          kind,
          templateVersion: template.version,
          latencyMs: null,
          checks: [],
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  for (const fixture of editPlanFixtures) {
    try {
      const { output, latencyMs } = await generateWithOllama(editPlanTemplate, fixture.input, {
        baseUrl,
        model,
        normalize: (raw) => normalizeEditPlanOutput(raw, fixture.input.planTier),
      });
      const checks = runEditPlanChecks(fixture.input, output);
      const ok = checks.every((c) => c.ok);
      cases.push({
        fixtureId: `plan:${fixture.id}`,
        kind: "edit-plan",
        templateVersion: EDIT_PLAN_TEMPLATE_VERSION,
        latencyMs,
        checks,
        ok,
      });
    } catch (error) {
      cases.push({
        fixtureId: `plan:${fixture.id}`,
        kind: "edit-plan",
        templateVersion: EDIT_PLAN_TEMPLATE_VERSION,
        latencyMs: null,
        checks: [],
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failedCases = cases.filter((c) => !c.ok).length;
  return {
    generatedAt: new Date().toISOString(),
    provider: "ollama",
    baseUrl,
    model,
    skipped: false,
    cases,
    totalCases: cases.length,
    failedCases,
    ok: failedCases === 0,
  };
}

export function renderLocalMarkdown(report: LocalEvalReport): string {
  const lines: string[] = [];
  lines.push("# @montaj/prompts eval:local report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}  `);
  lines.push(`Provider: ollama (${report.model} @ ${report.baseUrl})  `);
  if (report.skipped) {
    lines.push(`Result: **SKIPPED** — ${report.skipReason ?? "Ollama not reachable"}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Result: **${report.ok ? "PASS" : "FAIL"}** (${String(report.totalCases - report.failedCases)}/${String(report.totalCases)})`,
  );
  lines.push("");
  lines.push("| Fixture | Kind | Template | Latency (ms) | Result | Failing checks |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    const failing =
      c.error !== undefined
        ? [c.error]
        : c.checks.filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`);
    lines.push(
      `| ${c.fixtureId} | ${c.kind} | ${c.templateVersion} | ${c.latencyMs === null ? "—" : c.latencyMs.toFixed(0)} | ${c.ok ? "✅" : "❌"} | ${failing.length > 0 ? failing.join("<br>") : "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
