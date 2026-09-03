import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ThresholdResult } from "./thresholds.js";

/**
 * `docs/verification/**` report conventions (see `docs/verification/
 * verify-wave-2026-09-03.md`, `docs/verification/load-2026-09-02.md`): a
 * dated Markdown report a human can read, plus the machine-readable JSON
 * beside it. Filename per the brief: `local-engine-<profile>-<date>.md`.
 */

export interface ItemResult {
  readonly itemId: string;
  readonly model: string;
  readonly language: string;
  readonly wer: number;
  readonly cer: number;
  readonly onsetErrorMedianMs: number | null;
  readonly wallClockS: number;
  readonly peakRssMb: number | null;
  readonly boundaryError: ThresholdResult;
  readonly werResult: ThresholdResult;
  readonly latencyResult: ThresholdResult;
  readonly note?: string;
}

export interface BenchReport {
  readonly generatedAt: string;
  readonly profileSlug: string;
  readonly platform: NodeJS.Platform;
  readonly cores: number;
  readonly ramGb: number;
  readonly backend: string;
  readonly harnessTier: string;
  readonly reportedTier: string;
  readonly tierMatch: ThresholdResult;
  readonly gate: "evaluated" | "skipped-fake-backend";
  readonly overall: string;
  readonly items: readonly ItemResult[];
}

export function writeReport(report: BenchReport, mdPath: string, jsonPath: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  mkdirSync(dirname(mdPath), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
}

function fmtVerdict(v: ThresholdResult): string {
  const icon = v.verdict === "pass" ? "PASS" : v.verdict === "fail" ? "FAIL" : "N/A";
  return `${icon} — ${v.detail}`;
}

function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(`# Local engine quality gate — ${report.profileSlug} — ${report.generatedAt}`);
  lines.push("");
  if (report.gate === "skipped-fake-backend") {
    lines.push(
      "**Gate status: not evaluated.** This run is against `FakeBackend` — plumbing, thresholds " +
        'and report format only, per the brief\'s "Reality" section. The quality gate only ' +
        "passes from a real-backend run on a Gate C machine (see `docs/GATE-C-CHECKLIST.md`).",
    );
  } else {
    lines.push(`**Gate status: ${report.overall.toUpperCase()}.**`);
  }
  lines.push("");
  lines.push("## Machine profile");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Platform | ${report.platform} |`);
  lines.push(`| Cores | ${String(report.cores)} |`);
  lines.push(`| RAM (GB) | ${report.ramGb.toFixed(1)} |`);
  lines.push(`| Backend | ${report.backend} |`);
  lines.push(`| Harness-detected tier | ${report.harnessTier} |`);
  lines.push(`| Server-reported tier (\`/health\`) | ${report.reportedTier} |`);
  lines.push(`| Tier match | ${fmtVerdict(report.tierMatch)} |`);
  lines.push("");
  lines.push("## Per-item results");
  lines.push("");
  lines.push(
    "| Item | Model | WER | CER | Boundary error (median ms) | Wall clock (s) | Peak RSS (MB) | WER gate | Boundary gate | Latency gate | Note |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const item of report.items) {
    lines.push(
      `| ${item.itemId} | ${item.model} | ${item.wer.toFixed(4)} | ${item.cer.toFixed(4)} | ` +
        `${item.onsetErrorMedianMs === null ? "n/a" : item.onsetErrorMedianMs.toFixed(1)} | ` +
        `${item.wallClockS.toFixed(3)} | ${item.peakRssMb === null ? "n/a" : item.peakRssMb.toFixed(1)} | ` +
        `${item.werResult.verdict} | ${item.boundaryError.verdict} | ${item.latencyResult.verdict} | ` +
        `${item.note ?? ""} |`,
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- Latency thresholds (`03-architecture/05-system-architecture.md` §7: tier A <=60s, B <=90s, " +
      "C <=120s) are defined for a 5-minute clip; the fixture items here are far shorter, so the " +
      "wall-clock figures above are a plumbing check on the threshold math, not a real latency " +
      "measurement — a real-backend run against the actual 90s/5-minute clip is what the gate " +
      "means to measure.",
  );
  lines.push(
    "- Peak RSS is the harness process's own `process.memoryUsage().rss` sampled around each " +
      "call (`FakeBackend` runs in-process); a real-backend run should spawn the engine as its " +
      "own process and sample that process's RSS instead, since a native whisper.cpp/Silero " +
      "process's memory is what the budget actually cares about.",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}
