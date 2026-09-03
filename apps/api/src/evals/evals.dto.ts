import { z } from "zod";

import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * One `(dataset, metric)` row from a worker eval run (D08 §3/§6). `provider`
 * is absent for the kinds with no provider concept (transliteration, autocut,
 * llm); `metricName`/`metricValue` follow `worker_ai/evals/runner_datasets.py`'s
 * `DatasetReport.metrics` keys (`corpusWer`, `corpusCer`,
 * `transliterationAccuracy`, `autocutPrecision`/`Recall`/`F1`, `der`,
 * `llmPassRate`).
 */
export const EvalResultRowSchema = z.object({
  dataset: z.string().trim().min(1).max(200),
  kind: z.enum(["transcript", "transliteration", "autocut", "diarisation", "llm"]),
  language: z.string().trim().min(1).max(32),
  provider: z.string().trim().min(1).max(64).optional(),
  metricName: z.string().trim().min(1).max(100),
  metricValue: z.number().finite(),
  itemCount: z.number().int().min(0),
});
export type EvalResultRow = z.infer<typeof EvalResultRowSchema>;

/** `POST /internal/evals/runs` body (`worker_ai.evals.nightly.post_nightly_report`). */
export const EvalRunIngestSchema = z.object({
  trigger: z.enum(["nightly", "manual", "ci"]),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  routingFrozen: z.boolean().default(false),
  gitSha: z.string().trim().max(64).nullable().optional(),
  summary: z.object({
    datasetsRun: z.array(z.string()).default([]),
    datasetsSkipped: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
  }),
  results: z.array(EvalResultRowSchema).max(2_000),
});
export class EvalRunIngestDto extends zodDto(EvalRunIngestSchema) {}

export interface EvalRunIngestAck {
  readonly runId: string;
  readonly applied: boolean;
}
