/**
 * CLI entry for `pnpm --filter @montaj/prompts eval`: runs {@link run}, writes
 * `eval-results/report.json` and `eval-results/report.md`, and exits 1 when
 * any case failed — so a broken template or a regressed check fails CI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderMarkdown, run } from "./runner.js";

const outDir = join(__dirname, "..", "..", "eval-results");

function main(): void {
  const report = run();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report));

  // eslint-disable-next-line no-console
  console.log(
    `@montaj/prompts eval: ${report.ok ? "PASS" : "FAIL"} (${String(report.totalCases - report.failedCases)}/${String(report.totalCases)}) — see eval-results/report.md`,
  );
  if (!report.ok) {
    for (const c of report.cases.filter((x) => !x.ok)) {
      for (const check of c.checks.filter((k) => !k.ok)) {
        console.error(`  ✗ ${c.fixtureId}/${c.kind} [${check.name}] ${check.detail}`);
      }
    }
    process.exitCode = 1;
  }
}

main();
