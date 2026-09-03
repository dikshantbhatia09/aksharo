import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The "Node + a thin Python metrics call" the brief asks for: WER/CER reuse
 * D08's `worker_ai.evals.metrics` (Indic-aware normalisation, jiwer under the
 * hood) via the small CLI added at `apps/worker-ai/worker_ai/evals/
 * local_engine.py`, rather than a second implementation of word-error scoring
 * in TypeScript. One `spawnSync` per fixture item: the payload goes in on
 * stdin as JSON, the score comes back on stdout as JSON — no long-lived
 * Python process to manage from the harness.
 */

export interface MetricsRequest {
  readonly referenceText: string;
  readonly hypothesisText: string;
  readonly referenceWordsMs?: readonly number[];
  readonly hypothesisWordsMs?: readonly number[];
}

export interface MetricsResult {
  readonly wer: number;
  readonly cer: number;
  readonly onsetErrorMedianMs: number | null;
}

export class MetricsBridgeError extends Error {}

/** `apps/worker-ai/.venv`'s interpreter, the same one `scripts/py.mjs` creates and maintains. */
export function workerAiVenvPython(workerAiDir: string): string {
  const isWindows = process.platform === "win32";
  return isWindows
    ? join(workerAiDir, ".venv", "Scripts", "python.exe")
    : join(workerAiDir, ".venv", "bin", "python");
}

export function callLocalEngineMetrics(
  workerAiDir: string,
  request: MetricsRequest,
): MetricsResult {
  const python = workerAiVenvPython(workerAiDir);
  if (!existsSync(python)) {
    throw new MetricsBridgeError(
      `worker-ai venv not found at ${python} — run 'pnpm --filter @montaj/worker-ai setup' first.`,
    );
  }
  const result = spawnSync(python, ["-m", "worker_ai.evals.local_engine"], {
    cwd: workerAiDir,
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  if (result.error) {
    throw new MetricsBridgeError(`failed to spawn ${python}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new MetricsBridgeError(
      `worker_ai.evals.local_engine exited ${String(result.status)}: ${result.stderr}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as MetricsResult;
  } catch (error) {
    throw new MetricsBridgeError(
      `could not parse local_engine's stdout as JSON: ${String(error)} (stdout: ${result.stdout})`,
    );
  }
}
