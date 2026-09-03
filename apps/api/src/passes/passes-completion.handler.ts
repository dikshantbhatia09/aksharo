import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { newId } from "@montaj/edg";
import type {
  CutPassItem,
  Pass,
  ReframePassItem,
  SfxPassItem,
  TextFxIntent,
  TextFxMotionPreset,
  TitlePassItem,
  WordId,
  ZoomPassItem,
} from "@montaj/edg/schemas";

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
 * ### `PassType` and `keyframesRef` gaps (B19) — closed by B19b
 *
 * `PassTypeSchema` gained `"zoom"` (CONTRACTS §2, amended 2026-09-03), so
 * `handleZoom` now mints a `Pass` with `type: "zoom"` rather than borrowing
 * `"reframe"`.
 *
 * The keyframe payload rule (CONTRACTS §2, same amendment) is implemented
 * here: the worker (`worker_ai.processors.reframe_zoom_pass.
 * _keyframe_storage_fields`) already decided inline vs. derived storage and
 * minted the item id the derived key needed, so this handler only decodes
 * `keyframes` (hex on the wire) to base64 for `payload.keyframes`, or passes
 * `keyframesRef` through unchanged — it never uploads bytes itself, matching
 * `ObjectStore`'s "bytes never pass through the API" rule.
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

/**
 * Keyframe payload rule (CONTRACTS §2, added 2026-09-03 after B19b): the
 * worker packs MKF2 (`packages/edg/src/passes/keyframes.ts`) and sends it
 * either as `keyframes` (packed bytes, hex-encoded for JSON transit) when
 * <= 64 KiB, or as `keyframesRef` when it already uploaded the curve to
 * derived storage (`worker_ai.processors.reframe_zoom_pass.
 * _keyframe_storage_fields`) — exactly one, never both. `itemId` is minted by
 * the worker (not this handler) because the derived key needs it before the
 * object can be uploaded.
 */
const keyframeResultFields = {
  itemId: z.string().min(1),
  keyframes: z.string().min(1).optional(),
  keyframesRef: z.string().min(1).optional(),
};

function hasExactlyOneKeyframeResultField(value: {
  keyframes?: string | undefined;
  keyframesRef?: string | undefined;
}): boolean {
  return (value.keyframes !== undefined) !== (value.keyframesRef !== undefined);
}

const ZoomItemResultSchema = z
  .object({
    ...keyframeResultFields,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    scaleFrom: z.number().gt(0),
    scaleTo: z.number().gt(0),
    target: RectResultSchema,
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .refine(hasExactlyOneKeyframeResultField, {
    message: "exactly one of `keyframes` or `keyframesRef` is required",
  });

const ZoomResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("zoom"),
  preset: z.string().min(1),
  items: z.array(ZoomItemResultSchema).default([]),
});

const ReframeItemResultSchema = z
  .object({
    ...keyframeResultFields,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    aspect: z.enum(["9:16", "1:1"]),
    letterboxScenes: z.array(z.number().int().min(0)).default([]),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .refine(hasExactlyOneKeyframeResultField, {
    message: "exactly one of `keyframes` or `keyframesRef` is required",
  });

const ReframeResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("reframe"),
  items: z.array(ReframeItemResultSchema).default([]),
});

/** One title event from `worker_ai.processors.text_fx_pass.process_text_fx` (D06). */
const TextFxItemResultSchema = z.object({
  text: z.string().min(1),
  intent: z.enum(["title", "stat", "quote", "hook"]),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  anchorWordIds: z.array(z.string()).default([]),
  motionPreset: z.enum(["pop", "slide-up", "typewriter", "underline", "count-up", "fade"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

const TextFxResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("textfx"),
  items: z.array(TextFxItemResultSchema).default([]),
});

/** A duck curve, or `null` when the cue should never be ducked (D04c). */
const DuckResultSchema = z
  .object({
    depthDb: z.number(),
    attackMs: z.number().int().min(0),
    releaseMs: z.number().int().min(0),
  })
  .nullable();

/** One SFX cue from `worker_ai.processors.sfx_pass.process_sfx` (D04c). */
const SfxItemResultSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  assetId: z.string().min(1),
  packId: z.string().min(1),
  gainDb: z.number(),
  fadeInMs: z.number().int().min(0).default(0),
  fadeOutMs: z.number().int().min(0).default(0),
  duck: DuckResultSchema,
  licenceSnapshot: z.record(z.string(), z.unknown()).default({}),
  cueReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

const SfxResultSchema = z.object({
  passId: z.string().min(1),
  passType: z.literal("sfx"),
  items: z.array(SfxItemResultSchema).default([]),
});

/**
 * Advisory default placement per intent (`render-core`'s
 * `DEFAULT_PRESET_BY_INTENT`/slot order mirrored, not imported — this handler
 * has no TypeScript dependency on `@montaj/render-core`); `placeTitleBox`
 * recomputes the real per-frame rectangle from the caption's live safe area,
 * so this only needs to be a reasonable stored default.
 */
const DEFAULT_POSITION: { x: number; y: number; anchor: string } = {
  x: 0.5,
  y: 0.12,
  anchor: "top-center",
};

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
    if (passType === "textfx") return this.handleTextFx(context, projectId);
    if (passType === "sfx") return this.handleSfx(context, projectId);
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
      const keyframeFields = keyframePayloadFieldsOf(item);
      return {
        itemId: item.itemId,
        passId: result.passId,
        kind: "zoom",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: {
          target: item.target,
          scaleFrom: item.scaleFrom,
          scaleTo: item.scaleTo,
          easing: "easeInOut",
          ...keyframeFields,
        },
        ...(item.keyframesRef === undefined ? {} : { keyframesRef: item.keyframesRef }),
        confidence: item.confidence,
        reason: item.reason,
        state: "proposed",
      };
    });

    const pass: Pass = {
      passId: result.passId,
      type: "zoom",
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
      const keyframeFields = keyframePayloadFieldsOf(item);
      return {
        itemId: item.itemId,
        passId: result.passId,
        kind: "reframe",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: { aspect: item.aspect, ...keyframeFields },
        ...(item.keyframesRef === undefined ? {} : { keyframesRef: item.keyframesRef }),
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

  private async handleTextFx(
    context: JobCompletionContext,
    projectId: string,
  ): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = TextFxResultSchema.parse(context.result);

    const items: TitlePassItem[] = result.items.map((item) => ({
      itemId: newId(),
      passId: result.passId,
      kind: "title",
      startMs: item.startMs,
      endMs: item.endMs,
      payload: {
        text: item.text,
        styleRef: "system:textfx-default",
        position: DEFAULT_POSITION,
        animIn: item.motionPreset,
        animOut: item.motionPreset,
        intent: item.intent as TextFxIntent,
        motionPreset: item.motionPreset as TextFxMotionPreset,
        anchorWordIds: item.anchorWordIds as WordId[],
        layoutHint: "top-third",
      },
      confidence: item.confidence,
      reason: item.reason,
      state: "proposed",
    }));

    const pass: Pass = {
      passId: result.passId,
      type: "textfx",
      engine: "textfx@keyphrases@1",
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
      "textfx pass merged into the editing document",
    );

    return {
      data: {
        passId: result.passId,
        itemCount: items.length,
        edgRevision: applied.revision,
      },
    };
  }

  /**
   * D04c: `worker_ai.processors.sfx_pass.process_sfx`'s cues, one `PassItem
   * {kind:"sfx"}` each. `itemId` is minted here (the worker's `SfxItem`
   * dataclass carries none, same as `autocut`'s `CutCandidate`) — unlike
   * `zoom`/`reframe` there is no keyframe curve needing an id before upload.
   */
  private async handleSfx(
    context: JobCompletionContext,
    projectId: string,
  ): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = SfxResultSchema.parse(context.result);

    const items: SfxPassItem[] = result.items.map((item) => ({
      itemId: newId(),
      passId: result.passId,
      kind: "sfx",
      startMs: item.startMs,
      endMs: item.endMs,
      payload: {
        assetId: item.assetId,
        packId: item.packId,
        startMs: item.startMs,
        durationMs: item.endMs - item.startMs,
        gainDb: item.gainDb,
        fadeInMs: item.fadeInMs,
        fadeOutMs: item.fadeOutMs,
        duck: item.duck,
        licenceSnapshot: item.licenceSnapshot,
        cueReason: item.cueReason,
      },
      confidence: item.confidence,
      reason: item.reason,
      state: "proposed",
      licenceSnapshot: item.licenceSnapshot,
    }));

    const pass: Pass = {
      passId: result.passId,
      type: "sfx",
      engine: "sfx@1",
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
      "sfx pass merged into the editing document",
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

/**
 * The keyframe payload rule (CONTRACTS §2, B19b): `keyframes` inline (base64,
 * re-encoded from the worker's hex) when the worker sent it, else
 * `keyframesRef` passed through unchanged. Exactly one is ever set — the
 * result schema's `refine` already guarantees that.
 */
function keyframePayloadFieldsOf(item: {
  readonly keyframes?: string | undefined;
  readonly keyframesRef?: string | undefined;
}): { keyframes: string } | { keyframesRef: string } {
  if (item.keyframes !== undefined) {
    return { keyframes: Buffer.from(item.keyframes, "hex").toString("base64") };
  }
  return { keyframesRef: item.keyframesRef as string };
}

function passTypeOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)["passType"];
  return typeof value === "string" ? value : undefined;
}
