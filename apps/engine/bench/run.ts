import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineClient } from "@montaj/engine-client";

import { loadHinglishReference, type ReferenceItem } from "./fixture.js";
import { callLocalEngineMetrics, MetricsBridgeError } from "./metrics-bridge.js";
import { writeReport } from "./report.js";
import { currentMachineProfile } from "./system-profile.js";
import {
  defaultQualityGateConfig,
  evaluateBoundaryError,
  evaluateLatency,
  evaluateTierMatch,
  evaluateWer,
  overallVerdict,
} from "./thresholds.js";
import { FakeBackend } from "../src/backends/fake-backend.js";
import { defaultManifest } from "../src/manifest.js";
import { ModelManager } from "../src/model-manager.js";
import { startEngineServer, type EngineServerHandle } from "../src/server.js";

import type { BenchReport, ItemResult } from "./report.js";

/**
 * C03b's local-engine quality-gate harness (brief scope items 2-3): for each
 * model and (today, `FakeBackend`) backend, calls `/transcribe` + `/align`
 * through `@montaj/engine-client` exactly as `apps/desktop` would, scores the
 * result against the committed Hinglish reference set, checks the machine's
 * detected tier against `/health`'s, and writes a dated report under
 * `docs/verification/`.
 *
 * Run with: `pnpm --filter @montaj/engine bench` (see `package.json`'s
 * `bench` script). The same command runs unchanged against a real backend
 * once one exists (`EngineBackend`'s seam, `../src/backends/types.ts`) — only
 * `main.ts`'s backend construction changes, never this harness.
 */

const MODELS = ["turbo-q5_0", "small"] as const;

// CommonJS output (this package's `type: "commonjs"`), so `__dirname` is
// available natively — no `import.meta.url` dance needed.
const ENGINE_DIR = join(__dirname, "..");
const WORKTREE_ROOT = join(ENGINE_DIR, "..", "..");
const WORKER_AI_DIR = join(WORKTREE_ROOT, "apps", "worker-ai");
// CI redirects this to a scratch dir so a bench run never dirties the repo's
// own `docs/verification/` (`.github/workflows/local-engine-bench.yml`); a
// human running the harness locally gets the real report path by default.
const VERIFICATION_DIR =
  process.env["LOCAL_ENGINE_BENCH_OUT_DIR"] ?? join(WORKTREE_ROOT, "docs", "verification");

async function startFakeBackendServer(): Promise<{
  handle: EngineServerHandle;
  bearer: string;
  reportedTier: string;
  backendKind: string;
}> {
  const modelsDir = mkdtempSync(join(tmpdir(), "aksharo-engine-bench-"));
  const modelManager = new ModelManager({
    manifest: defaultManifest(),
    baseUrl: "https://models.aksharo.ai",
    modelsDir,
    diskBudgetBytes: 5 * 1024 ** 3,
  });
  await modelManager.verifyAll();

  const profile = currentMachineProfile();
  const backend = new FakeBackend();
  const bearer = "bench-harness-bearer-0123456789abcdef";
  const handle = await startEngineServer({
    bearer,
    backend,
    modelManager,
    detection: profile.detection,
    startedAt: Date.now(),
  });
  return { handle, bearer, reportedTier: profile.detection.tier, backendKind: backend.kind };
}

function peakRssMb(): number {
  return process.memoryUsage().rss / 1024 ** 2;
}

async function scoreItem(
  client: EngineClient,
  item: ReferenceItem,
  model: string,
): Promise<ItemResult> {
  const startedAt = process.hrtime.bigint();
  const rssBefore = peakRssMb();

  const transcribe = await client.transcribe({
    audio: item.audioMatch,
    model,
    language: item.language,
    wordTimestamps: true,
  });

  const referenceWords = item.words?.map((w) => w.word) ?? transcribe.words.map((w) => w.word);
  const align = await client.align({
    audio: item.audioMatch,
    words: referenceWords,
    language: item.language,
    startS: 0,
  });

  const wallClockS = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const rssAfter = peakRssMb();

  const hypothesisText = transcribe.segments
    .map((s) => s.text)
    .join(" ")
    .trim();
  const referenceWordsMs = item.words?.map((w) => w.startMs);
  const hypothesisWordsMs =
    item.words === null ? undefined : align.words.map((w) => Math.round(w.start * 1000));

  let metrics: { wer: number; cer: number; onsetErrorMedianMs: number | null };
  try {
    metrics = callLocalEngineMetrics(WORKER_AI_DIR, {
      referenceText: item.referenceText,
      hypothesisText,
      referenceWordsMs,
      hypothesisWordsMs,
    });
  } catch (error) {
    if (error instanceof MetricsBridgeError) {
      throw new Error(`metrics bridge failed for ${item.id}/${model}: ${error.message}`);
    }
    throw error;
  }

  const config = defaultQualityGateConfig;
  const boundaryError = evaluateBoundaryError(metrics.onsetErrorMedianMs, config);
  const werResult = evaluateWer(metrics.wer, config);
  const latencyResult = evaluateLatency("A", wallClockS, config);

  return {
    itemId: item.id,
    model,
    language: item.language,
    wer: metrics.wer,
    cer: metrics.cer,
    onsetErrorMedianMs: metrics.onsetErrorMedianMs,
    wallClockS,
    peakRssMb: Math.max(rssBefore, rssAfter),
    boundaryError,
    werResult,
    latencyResult,
    note: item.note,
  };
}

async function main(): Promise<void> {
  const profile = currentMachineProfile();
  const { handle, bearer, backendKind } = await startFakeBackendServer();

  try {
    const client = new EngineClient({ baseUrl: `http://127.0.0.1:${String(handle.port)}`, bearer });
    const health = await client.health();
    const tierMatch = evaluateTierMatch(profile.detection.tier, health.tier);

    const items = loadHinglishReference();
    const results: ItemResult[] = [];
    for (const model of MODELS) {
      for (const item of items) {
        results.push(await scoreItem(client, item, model));
      }
    }

    const gate = backendKind === "fake" ? "skipped-fake-backend" : "evaluated";
    const overall =
      gate === "skipped-fake-backend"
        ? "not-applicable"
        : overallVerdict([
            tierMatch,
            ...results.flatMap((r) => [r.boundaryError, r.werResult, r.latencyResult]),
          ]);

    const report: BenchReport = {
      generatedAt: new Date().toISOString().slice(0, 10),
      profileSlug: profile.slug,
      platform: profile.platform,
      cores: profile.cores,
      ramGb: profile.ramGb,
      backend: backendKind,
      harnessTier: profile.detection.tier,
      reportedTier: health.tier,
      tierMatch,
      gate,
      overall,
      items: results,
    };

    const base = `local-engine-${profile.slug}-${report.generatedAt}`;
    writeReport(
      report,
      join(VERIFICATION_DIR, `${base}.md`),
      join(VERIFICATION_DIR, `${base}.json`),
    );

    // eslint-disable-next-line no-console -- CLI status output, not user data.
    console.log(
      JSON.stringify({ evt: "bench.report.written", base, gate, overall, items: results.length }),
    );

    if (gate === "evaluated" && overall === "fail") {
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
