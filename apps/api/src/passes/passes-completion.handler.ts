import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { newId } from "@montaj/edg";
import type { CutPassItem, Pass } from "@montaj/edg/schemas";

import { EdgService } from "../edg/index.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/**
 * What an `ai.pass` completion means, for `passType: "autocut"` (B18).
 *
 * Like `TranscribeCompletionHandler` (A11), the worker is stateless and never
 * writes a row: its completion carries `result.items` already shaped like cut
 * candidates (`worker_ai.processors.autocut_pass._item_wire`), and this handler
 * turns them into a `MergePass` op — the one write path `MergePass` has
 * (CONTRACTS §2, `edg-internal.controller.ts`) — landed through
 * `EdgService.applyWorkerOps` directly, in-process, rather than over HTTP: this
 * handler already runs inside the API, behind the same HMAC-verified job
 * completion callback the worker used to report in, so a second signed hop
 * would check nothing a first one has not already.
 *
 * `CutPayloadSchema` is frozen empty (CONTRACTS §2, `packages/edg/src/schemas/
 * pass.ts`), so `wordIds` the worker attaches for its own bookkeeping is read
 * here (for the job event, an audit trail a reviewer can read) and dropped
 * before the item is persisted — it never reaches the wire a second time.
 *
 * ### Idempotency
 *
 * `MergePass` itself is idempotent per `passId` (`applyMergePass` in
 * `packages/edg/src/ops/apply.ts`: a `passId` already in the document is a
 * silent no-op), so a replayed completion callback lands the same op twice and
 * the second lands nothing.
 */

const ItemResultSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  reason: z.enum(["silence", "pause", "filler", "retake"]),
  confidence: z.number().min(0).max(1),
  wordIds: z.array(z.string()).default([]),
});

const AutocutResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("autocut"),
  preset: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  counts: z.record(z.string(), z.number()).default({}),
  totalRemovedMs: z.number().int().min(0).default(0),
  totalKeptMs: z.number().int().min(0).default(0),
  items: z.array(ItemResultSchema).default([]),
});

@Injectable()
export class PassCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.pass";

  private readonly logger = new Logger(PassCompletionHandler.name);

  constructor(
    private readonly edg: EdgService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = AutocutResultSchema.parse(context.result);

    const projectId = job.projectId;
    if (projectId === null) {
      throw new Error(`job ${job.id} is an ai.pass with no project`);
    }

    const items: CutPassItem[] = result.items.map((item) => ({
      itemId: newId(),
      passId: result.passId,
      kind: "cut",
      startMs: item.startMs,
      endMs: item.endMs,
      payload: {},
      confidence: item.confidence,
      reason: item.reason,
      state: "proposed",
    }));

    const pass: Pass = {
      passId: result.passId,
      type: "autocut",
      engine: `autocut@${result.preset}`,
      params: result.params,
      status: "ready",
      jobId: job.id,
      items,
    };

    const document = await this.edg.document(projectId, job.workspaceId);
    const applied = await this.edg.applyWorkerOps({
      projectId,
      baseRevision: document.revision,
      ops: [{ opId: newId(), type: "MergePass", pass }],
      clientOpIds: [],
    });

    this.logger.log(
      {
        jobId: job.id,
        projectId,
        passId: result.passId,
        items: items.length,
        counts: result.counts,
        revision: applied.revision,
      },
      "autocut pass merged into the editing document",
    );

    return {
      data: {
        passId: result.passId,
        preset: result.preset,
        counts: result.counts,
        totalRemovedMs: result.totalRemovedMs,
        totalKeptMs: result.totalKeptMs,
        itemCount: items.length,
        edgRevision: applied.revision,
      },
    };
  }
}
