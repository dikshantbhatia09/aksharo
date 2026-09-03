/**
 * CLI entry for `pnpm --filter @montaj/prompts eval:local` (M20 free-stack
 * mode): runs {@link runLocal} against a real local Ollama server, writes
 * `eval-results/report-local.json`/`.md`, and exits 1 only on an actual
 * failure — a reachability skip exits 0 so this is safe to wire into a dev
 * script or CI without a local model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderLocalMarkdown, runLocal } from "./local-runner.js";

const outDir = join(__dirname, "..", "..", "eval-results");

async function main(): Promise<void> {
  const report = await runLocal();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report-local.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report-local.md"), renderLocalMarkdown(report));

  if (report.skipped) {
    // eslint-disable-next-line no-console
    console.log(
      `@montaj/prompts eval:local: SKIPPED — ${report.skipReason ?? "Ollama not reachable"}`,
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `@montaj/prompts eval:local: ${report.ok ? "PASS" : "FAIL"} (${String(report.totalCases - report.failedCases)}/${String(report.totalCases)}) — see eval-results/report-local.md`,
  );
  if (!report.ok) {
    for (const c of report.cases.filter((x) => !x.ok)) {
      if (c.error !== undefined) {
        console.error(`  ✗ ${c.fixtureId}/${c.kind}: ${c.error}`);
        continue;
      }
      for (const check of c.checks.filter((k) => !k.ok)) {
        console.error(`  ✗ ${c.fixtureId}/${c.kind} [${check.name}] ${check.detail}`);
      }
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
