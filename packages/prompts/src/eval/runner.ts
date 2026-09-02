/**
 * The eval runner (`pnpm --filter @montaj/prompts eval`, brief §1).
 *
 * Runs the fake/mock provider ({@link mockGenerate}) over every fixture
 * transcript for every insight-producing template, applies the automatic
 * checks, and returns a structured report. `writeReport` renders it as JSON
 * and Markdown; `run()` is the pure part unit tests exercise without touching
 * the filesystem.
 */
import { runChecks } from "./checks.js";
import { FIXTURES } from "./fixtures.js";
import { mockGenerate } from "./mock-provider.js";
import { INSIGHT_KINDS, templateFor } from "../templates/registry.js";

import type { CheckResult } from "./checks.js";
import type { Fixture } from "./fixtures.js";
import type { InsightKind } from "../templates/registry.js";

export interface EvalCase {
  readonly fixtureId: string;
  readonly kind: InsightKind;
  readonly templateVersion: string;
  readonly checks: readonly CheckResult[];
  readonly ok: boolean;
}

export interface EvalReport {
  readonly generatedAt: string;
  readonly provider: "mock";
  readonly cases: readonly EvalCase[];
  readonly totalCases: number;
  readonly failedCases: number;
  readonly ok: boolean;
}

export function run(fixtures: readonly Fixture[] = FIXTURES): EvalReport {
  const cases: EvalCase[] = [];
  for (const fixture of fixtures) {
    for (const kind of INSIGHT_KINDS) {
      const template = templateFor(kind);
      const input = { ...fixture.transcript, ...(kind === "hooks" ? { tone: "energetic" } : {}) };
      const parsedInput = template.inputSchema.parse(input);
      const output = mockGenerate(kind, parsedInput);
      const checks = runChecks(kind, template.outputSchema, output, fixture.transcript);
      const ok = checks.every((c) => c.ok);
      cases.push({ fixtureId: fixture.id, kind, templateVersion: template.version, checks, ok });
    }
  }
  const failedCases = cases.filter((c) => !c.ok).length;
  return {
    generatedAt: new Date().toISOString(),
    provider: "mock",
    cases,
    totalCases: cases.length,
    failedCases,
    ok: failedCases === 0,
  };
}

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("# @montaj/prompts eval report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}  `);
  lines.push(`Provider: ${report.provider}  `);
  lines.push(
    `Result: **${report.ok ? "PASS" : "FAIL"}** (${String(report.totalCases - report.failedCases)}/${String(report.totalCases)})`,
  );
  lines.push("");
  lines.push("| Fixture | Kind | Template | Result | Failing checks |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const c of report.cases) {
    const failing = c.checks.filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`);
    lines.push(
      `| ${c.fixtureId} | ${c.kind} | ${c.templateVersion} | ${c.ok ? "✅" : "❌"} | ${failing.length > 0 ? failing.join("<br>") : "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
