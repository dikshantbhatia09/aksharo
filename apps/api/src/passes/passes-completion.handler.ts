import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { newId } from "@montaj/edg";
import type { CutPassItem, Pass, ReframePassItem, ZoomPassItem } from "@montaj/edg/schemas";

import { EdgService } from "../edg/index.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/**
 * What an `ai.pass` completion means, for `passType: "autocut"` (B18) and
 * `"zoom"`/`"reframe"` (B19).
 *
 * Like `TranscribeCompletionHandler` (A11), the worker is stateless and never
 * writes a row: its completion carries `result.items` already shaped like cut
 * candidates (`worker_ai.processors.autocut_pass._item_wire`) or zoom/reframe
 * events (`worker_ai.processors.reframe_zoom_pass`), and this handler turns
 * them into a `MergePass` op — the one write path `MergePass` has
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
 * ### `PassType` gap (B19, flagged in the final report rather than silently worked around)
 *
 * `PassTypeSchema` (CONTRACTS §2, `packages/edg/src/schemas/pass.ts`) has no
 * `"zoom"` value — only `ItemKindSchema` does. Both `startZoom` and
 * `startReframe` therefore mint a `Pass` with `type: "reframe"` (the WP's own
 * title, "reframe & zoom pass", treats them as one family), distinguished by
 * each item's own `kind` (`"zoom"` vs `"reframe"`) and the pass's `engine`
 * string (`zoom@<preset>` vs `reframe@<aspect>`).
 *
 * ### `keyframesRef` gap (B19, flagged in the final report)
 *
 * The 2026-09-02 orchestrator addendum asks for packed keyframes <= 64 KiB to
 * stay inline on `edg_pass_items.keyframes` (bytea) and larger ones to go to
 * derived storage at `keyframesRef`. Neither write path exists yet:
 * `PassItem` (CONTRACTS §2) carries only `keyframesRef: string`, never inline
 * bytes, and `ObjectStore` (`apps/api/src/common/storage/object-store.ts`)
 * has no `putObject` — uploads are deliberately client-presigned only
 * ("bytes never pass through the API"). This handler computes the
 * addendum's own key shape (`passes/{passId}/{itemId}.kf`) and sets
 * `keyframesRef` to it, but nothing yet writes the bytes there; the packed
 * payload the worker produced is logged (byte length only) so a reviewer can
 * see the gap rather than a silently-empty ref. Closing this needs either an
 * internal `putObject` on `ObjectStore` (owned by `common/storage/**`,
 * outside B19's file boundary) or the worker writing the `.kf` directly via
 * its own storage client, mirroring how A07's derived media never passes
 * through the API either.
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

const RectResultSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const ZoomItemResultSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  keyframes: z.string().min(1), // packed float32 rows, hex-encoded
  scaleFrom: z.number().gt(0),
  scaleTo: z.number().gt(0),
  target: RectResultSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const ZoomResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("zoom"),
  preset: z.string().min(1),
  items: z.array(ZoomItemResultSchema).default([]),
});

const ReframeItemResultSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  aspect: z.enum(["9:16", "1:1"]),
  keyframes: z.string().min(1),
  letterboxScenes: z.array(z.number().int().min(0)).default([]),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const ReframeResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("reframe"),
  items: z.array(ReframeItemResultSchema).default([]),
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
    const projectId = job.projectId;
    if (projectId === null) {
      throw new Error(`job ${job.id} is an ai.pass with no project`);
    }

    const passType = passTypeOf(context.result);
    if (passType === "zoom") return this.handleZoom(context, projectId);
    if (passType === "reframe") return this.handleReframe(context, projectId);
    return this.handleAutocut(context, projectId);
  }

  private async handleAutocut(
    context: JobCompletionContext,
    projectId: string,
  ): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = AutocutResultSchema.parse(context.result);

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

    const applied = await this.mergePass(projectId, job.workspaceId, pass);

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

  private async handleZoom(
    context: JobCompletionContext,
    projectId: string,
  ): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = ZoomResultSchema.parse(context.result);

    const items: ZoomPassItem[] = result.items.map((item) => {
      const itemId = newId();
      const keyframesRef = keyframesRefFor(result.passId, itemId);
      this.logger.log(
        { itemId, keyframesRef, bytes: Buffer.from(item.keyframes, "hex").byteLength },
        "zoom item keyframes computed (not yet written to derived storage - see class docstring)",
      );
      return {
        itemId,
        passId: result.passId,
        kind: "zoom",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: {
          target: item.target,
          scaleFrom: item.scaleFrom,
          scaleTo: item.scaleTo,
          easing: "easeInOut",
          keyframesRef,
        },
        keyframesRef,
        confidence: item.confidence,
        reason: item.reason,
        state: "proposed",
      };
    });

    const pass: Pass = {
      passId: result.passId,
      type: "reframe", // PassTypeSchema has no "zoom" value -- see class docstring
      engine: `zoom@${result.preset}`,
      params: { preset: result.preset },
      status: "ready",
      jobId: job.id,
      items,
    };

    const applied = await this.mergePass(projectId, job.workspaceId, pass);

    this.logger.log(
      {
        jobId: job.id,
        projectId,
        passId: result.passId,
        items: items.length,
        revision: applied.revision,
      },
      "zoom pass merged into the editing document",
    );

    return {
      data: {
        passId: result.passId,
        preset: result.preset,
        itemCount: items.length,
        edgRevision: applied.revision,
      },
    };
  }

  private async handleReframe(
    context: JobCompletionContext,
    projectId: string,
  ): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = ReframeResultSchema.parse(context.result);

    const items: ReframePassItem[] = result.items.map((item) => {
      const itemId = newId();
      const keyframesRef = keyframesRefFor(result.passId, itemId);
      this.logger.log(
        {
          itemId,
          keyframesRef,
          bytes: Buffer.from(item.keyframes, "hex").byteLength,
          letterboxScenes: item.letterboxScenes,
        },
        "reframe item keyframes computed (not yet written to derived storage - see class docstring)",
      );
      return {
        itemId,
        passId: result.passId,
        kind: "reframe",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: { aspect: item.aspect, keyframesRef },
        keyframesRef,
        confidence: item.confidence,
        reason: item.reason,
        state: "proposed",
      };
    });

    const pass: Pass = {
      passId: result.passId,
      type: "reframe",
      engine: `reframe@${items[0]?.payload.aspect ?? "9:16"}`,
      params: {},
      status: "ready",
      jobId: job.id,
      items,
    };

    const applied = await this.mergePass(projectId, job.workspaceId, pass);

    this.logger.log(
      {
        jobId: job.id,
        projectId,
        passId: result.passId,
        items: items.length,
        revision: applied.revision,
      },
      "reframe pass merged into the editing document",
    );

    return {
      data: {
        passId: result.passId,
        itemCount: items.length,
        edgRevision: applied.revision,
      },
    };
  }

  private async mergePass(
    projectId: string,
    workspaceId: string,
    pass: Pass,
  ): Promise<{ revision: number }> {
    const document = await this.edg.document(projectId, workspaceId);
    return this.edg.applyWorkerOps({
      projectId,
      baseRevision: document.revision,
      ops: [{ opId: newId(), type: "MergePass", pass }],
      clientOpIds: [],
    });
  }
}

/** The addendum's derived-storage key shape (class docstring's "keyframesRef gap"). */
function keyframesRefFor(passId: string, itemId: string): string {
  return `passes/${passId}/${itemId}.kf`;
}

function passTypeOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)["passType"];
  return typeof value === "string" ? value : undefined;
}
