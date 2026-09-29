import { HttpStatus, Injectable, Logger, Optional } from "@nestjs/common";

import {
  brandCaptionOverrides,
  brandEndCardOverlay,
  brandHookAppearance,
  brandLogoOverlay,
  brandMusicPass,
  newId,
  stableOverlayId,
} from "@montaj/edg";
import type {
  CutPassItem,
  EdgOp,
  EdgProjection,
  Pass,
  PassItem,
  TranscriptChunk,
  WordId,
} from "@montaj/edg/schemas";
import { mergeOverrides } from "@montaj/render-core";
import { fromAcceptedItems } from "@montaj/timemap";

import { hasNoPicture } from "./audiogram.js";
import { chooseEmphasis, normaliseWord } from "./keyword-emphasis.js";
import { brandOf } from "./repurpose.constants.js";
import { BrandKitService } from "../brand-kit/brand-kit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { EdgRepository, EdgService } from "../edg/index.js";
import { resolveStyleSnapshot } from "../exports/projection.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { PassesService } from "../passes/passes.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { Prisma, RepurposeRun } from "@prisma/client";

/**
 * Autopilot's finishing pass (2026-09-29): a clip comes out looking edited,
 * not raw. Before the captioned video of a clip shape is asked for, its
 * project gets, in this order:
 *
 * 1. **autocut** — silences, long pauses, fillers and retakes cut. The 9:16
 *    shape runs the pass (`PassesService.startAutocut`, `standard`) and every
 *    proposal it is confident about is accepted; the other shapes of the same
 *    clip take the 9:16 cuts as they are (their timelines are the same cut of
 *    the same moment), so every format runs the same length and none of them
 *    pays for the pass again.
 * 2. **emphasis** — one keyword per caption, two in a long one with a number
 *    or a name (`keyword-emphasis.ts`), in the style's first preset that reads
 *    as a keyword ({@link keywordPresetId}; usually `emphasisPresets[0]`, what
 *    "Emphasise word" uses in the editor). After the cuts, so it never lands
 *    on a word that was cut; before the zooms, so the zoom pass punches in on
 *    it.
 * 3. **zoom** — punch-ins on emphasis and energy (`startZoom`, `standard`),
 *    accepted, except any that would start while the hook title is up (a zoom
 *    moves the face the title was placed off, and two things moving at once in
 *    the first seconds is one too many). Not on 16:9: a wide frame is cut for
 *    YouTube, X and LinkedIn, where a talking head is small in the frame and a
 *    punch-in reads as a jump rather than as emphasis, and the zoom pass's
 *    framing was tuned on vertical reframes.
 * 4. **hook** — the hook title (`EdgHot.overlays`, drawn by render-core): the
 *    clip's `copy.hook`, else its title cut to seven words, over the first
 *    2.5 seconds of the finished (cut) video.
 * 5. **brand** (2026-10-02) — when the run asked for it (`setup.brand`) and the
 *    workspace has a brand kit: the captions in the kit's typeface and colours
 *    (document style overrides, merged onto the document's own), the hook
 *    title on the kit's card, the logo in its corner for the whole clip, and
 *    the end card over the last seconds of the finished video. Last, so it
 *    dresses the edit the steps above made. A run without it, or a workspace
 *    without a kit, gets exactly the clip it got before (`skipped`, `off` or
 *    `no-kit`).
 * 6. **music** (2026-10-04) - the kit's own track under the clip, for the same
 *    runs, when the kit has one and its music is on: one bed over the whole
 *    clip (`brandMusicPass`), looped, faded, and ducked under speech by the
 *    render. A clip that already has a bed - or one a person took off it - gets
 *    none, so their choice stands.
 *
 * A clip of a source with no picture (an audiogram, 2026-10-04) is never
 * zoomed: its picture is drawn, not filmed, and a punch-in only crops its
 * artwork and its waveform.
 *
 * **Never a failure.** A step the plan does not include, the credits cannot
 * pay for, or that fails or runs too long is recorded as skipped and the next
 * one runs; the captioned video is made either way. The whole pass gives up
 * waiting after {@link FINISHING_MAX_MS}.
 *
 * **Resumable and idempotent.** Each shape's progress is recorded on its
 * `clip_variants.finishing` row ({@link FinishingRecord}); the reconciler asks
 * again every pass (30 s, and on reads), and each ask moves at most as far as
 * it can without waiting. The passes dedupe on their job keys, accepting an
 * item twice changes nothing, the emphasis is only written on captions with
 * none, and the hook title's id is the variant's own, so a repeated or
 * concurrent ask writes nothing new.
 */

/** How long the hook title stays up: the first seconds decide whether a viewer stays. */
export const HOOK_TITLE_MS = 2_500;
/** A hook is read in a glance: at most this many words. */
export const HOOK_MAX_WORDS = 7;
/** The longest hook the document takes (`@montaj/edg` `OVERLAY_TEXT_MAX`). */
const HOOK_MAX_CHARS = 120;
/** How long a finished pass's items may take to reach the document. */
const LANDING_GRACE_MS = 2 * 60_000;
/** How long one pass may take to land before its step is skipped. */
export const FINISHING_STEP_MAX_MS = 20 * 60_000;
/** How long the whole pass may hold a captioned video back. */
export const FINISHING_MAX_MS = 45 * 60_000;
/** Two shapes of one clip share a timeline when their durations agree to this. */
const SAME_TIMELINE_MS = 100;
/** Autocut proposals below these confidences stay proposals for a person to judge. */
const MIN_CUT_CONFIDENCE = 0.5;
const MIN_RETAKE_CONFIDENCE = 0.75;

export const FINISHING_STEPS = ["autocut", "emphasis", "zoom", "hook", "brand", "music"] as const;
export type FinishingStep = (typeof FINISHING_STEPS)[number];

export interface FinishingStepRecord {
  readonly state: "requested" | "done" | "skipped";
  /** ISO time of the last change. */
  readonly at: string;
  readonly jobId?: string;
  readonly passId?: string;
  /** Why a step was skipped: `plan`, `credits`, `failed`, `timeout`, ... */
  readonly reason?: string;
  /** How many items, emphases or overlays it wrote. */
  readonly applied?: number;
  /** The variant whose cuts were copied (autocut on a shape other than 9:16). */
  readonly copiedFrom?: string;
}

/** `clip_variants.finishing`. */
export interface FinishingRecord {
  readonly v: 1;
  readonly state: "running" | "done";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps: Partial<Record<FinishingStep, FinishingStepRecord>>;
}

/** The stored record, or `null` for a shape never finished (a manual run's, an older one). */
export function finishingRecordOf(value: unknown): FinishingRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<FinishingRecord>;
  if (record.v !== 1 || (record.state !== "running" && record.state !== "done")) return null;
  if (typeof record.startedAt !== "string") return null;
  const steps = typeof record.steps === "object" && record.steps !== null ? record.steps : {};
  return { ...(record as FinishingRecord), steps };
}

/** Whether a shape is being finished now: the clip reads "Finishing the edit". */
export function finishingInProgress(value: unknown): boolean {
  return finishingRecordOf(value)?.state === "running";
}

/**
 * The hook title's words: the clip's own hook (`copy.hook`, written by the
 * copy model), else its title, cut to {@link HOOK_MAX_WORDS} words without a
 * dangling "and" or "ka" at the cut, and without closing punctuation other
 * than a question or an exclamation mark. Empty for a moment a person marked
 * without naming it ("Moment at 1:23–1:45" is a label, not a hook).
 */
export function hookTextOf(copy: unknown, title: string): string {
  const hook =
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)["hook"]
      : undefined;
  const fromCopy = typeof hook === "string" && hook.trim() !== "";
  if (!fromCopy && /^Moment at \d/u.test(title.trim())) return "";
  const words = (fromCopy ? (hook as string) : title)
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  let kept = words.slice(0, HOOK_MAX_WORDS);
  if (words.length > HOOK_MAX_WORDS) {
    // Cut mid-sentence: end on a word that carries meaning, not on "and" or "ka".
    while (kept.length > 1 && isDanglingEnd(kept.at(-1) ?? "")) kept = kept.slice(0, -1);
  }
  return kept
    .join(" ")
    .replace(/[\s,.;:–—-]+$/u, "")
    .slice(0, HOOK_MAX_CHARS);
}

/** Words a cut-short hook must not end on: it would read as if it trailed off. */
const DANGLING_ENDS: ReadonlySet<string> = new Set(
  `and or but the a an of to in on for with at by aur ka ki ke ko se me mein par ya
   और का की के को से में पर या`.split(/\s+/u),
);

function isDanglingEnd(word: string): boolean {
  return DANGLING_ENDS.has(normaliseWord(word));
}

/**
 * The source-clock window the hook title covers: the first {@link HOOK_TITLE_MS}
 * of the video as it plays after `items`' accepted cuts, so a cut at the very
 * start neither hides the title nor eats its entry.
 */
export function hookWindow(
  items: readonly PassItem[],
  sourceDurationMs: number,
): { readonly startMs: number; readonly endMs: number } | undefined {
  if (sourceDurationMs <= 0) return undefined;
  const timeMap = fromAcceptedItems(items, { sourceDurationMs });
  const outputEnd = Math.min(HOOK_TITLE_MS, timeMap.outputDurationMs);
  if (outputEnd <= 0) return undefined;
  const startMs = Math.max(0, Math.round(timeMap.toSource(0)));
  const endMs = Math.min(sourceDurationMs, Math.round(timeMap.toSource(outputEnd)));
  return endMs > startMs ? { startMs, endMs } : undefined;
}

/**
 * The source-clock window an end card covers (2026-10-02): the last `tailMs`
 * of the video as it plays after `items`' accepted cuts, so a cut near the end
 * never leaves the card short. `undefined` when the finished video is too
 * short to carry both the hook title and the card without one covering the
 * other.
 */
export function endCardWindow(
  items: readonly PassItem[],
  sourceDurationMs: number,
  tailMs: number,
): { readonly startMs: number; readonly endMs: number } | undefined {
  if (sourceDurationMs <= 0 || tailMs <= 0) return undefined;
  const timeMap = fromAcceptedItems(items, { sourceDurationMs });
  const outputEnd = timeMap.outputDurationMs;
  if (outputEnd < tailMs + HOOK_TITLE_MS) return undefined;
  const startMs = Math.max(0, Math.round(timeMap.toSource(outputEnd - tailMs)));
  return sourceDurationMs > startMs ? { startMs, endMs: sourceDurationMs } : undefined;
}

/** Whether an autocut proposal is sure enough to take on a person's behalf. */
export function acceptableCut(item: PassItem): boolean {
  if (item.kind !== "cut" || item.state !== "proposed") return false;
  const confidence = item.confidence ?? 1;
  return item.reason === "retake"
    ? confidence >= MIN_RETAKE_CONFIDENCE
    : confidence >= MIN_CUT_CONFIDENCE;
}

/** The variant a finishing pass works on, as `captionClips` reads it. */
export interface FinishingVariant {
  readonly id: string;
  readonly clipId: string;
  readonly projectId: string;
  readonly aspect: "r9x16" | "r4x5" | "r1x1" | "r16x9";
  readonly finishing: Prisma.JsonValue | null;
  /** How the shape's picture was cut (`clip_variants.layout`, 2026-10-01); one window when absent. */
  readonly layout?: string;
}

/** What one ask did: finished before it started, finished just now, or not yet. */
export type FinishingOutcome = "finished" | "just-finished" | "waiting";

type StepResult = FinishingStepRecord | "wait";

interface ShapeContext {
  readonly run: RepurposeRun;
  readonly variant: FinishingVariant;
  readonly now: Date;
  readonly previous: FinishingStepRecord | undefined;
  /** Past {@link FINISHING_MAX_MS}: nothing new is started, and nothing is waited for. */
  readonly overdue: boolean;
}

@Injectable()
export class ClipFinishing {
  private readonly logger = new Logger(ClipFinishing.name);
  /** Shapes being finished by this process right now: one ask at a time each. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly edg: EdgService,
    private readonly edgRepository: EdgRepository,
    private readonly entitlements: EntitlementService,
    @Optional() private readonly passes?: PassesService,
    /** The workspace's brand kit (2026-10-02); without it the brand step is skipped. */
    @Optional() private readonly brandKits?: BrandKitService,
  ) {}

  /**
   * Moves one shape's finishing as far as it can go without waiting.
   * `finished` when it was already done (the captioned video may be asked for
   * now), `just-finished` when this ask completed it (asked for on the next
   * pass, so the video's fingerprint is taken from the finished document),
   * `waiting` otherwise. Never throws.
   */
  async advance(
    run: RepurposeRun,
    variant: FinishingVariant,
    now: Date = new Date(),
  ): Promise<FinishingOutcome> {
    const stored = finishingRecordOf(variant.finishing);
    if (stored?.state === "done") return "finished";
    if (this.busy.has(variant.id)) return "waiting";
    this.busy.add(variant.id);
    try {
      return await this.step(run, variant, stored, now);
    } catch (error) {
      this.logger.warn(
        { runId: run.id, variantId: variant.id, err: error },
        "clip finishing could not move this pass; the next pass tries again",
      );
      return "waiting";
    } finally {
      this.busy.delete(variant.id);
    }
  }

  private async step(
    run: RepurposeRun,
    variant: FinishingVariant,
    stored: FinishingRecord | null,
    now: Date,
  ): Promise<FinishingOutcome> {
    const record: FinishingRecord = stored ?? {
      v: 1,
      state: "running",
      startedAt: now.toISOString(),
      steps: {},
    };
    const steps: Partial<Record<FinishingStep, FinishingStepRecord>> = { ...record.steps };
    const overdue = now.getTime() - Date.parse(record.startedAt) > FINISHING_MAX_MS;
    let changed = stored === null;

    for (const name of FINISHING_STEPS) {
      // eslint-disable-next-line security/detect-object-injection -- a closed enum of step names
      const previous = steps[name];
      if (previous !== undefined && previous.state !== "requested") continue;
      let result: StepResult;
      try {
        result = await this.runStep(name, { run, variant, now, previous, overdue });
      } catch (error) {
        // Overdue, a step that keeps failing is let go rather than retried.
        if (!overdue) throw error;
        this.logger.warn(
          { runId: run.id, variantId: variant.id, step: name, err: error },
          "an overdue finishing step failed; skipped",
        );
        result = skipped(now, "error");
      }
      // Overdue, what still waits (a pass that never landed, the 9:16 cuts)
      // is let go: emphasis and the hook title, which never wait, still run.
      if (overdue && result === "wait") result = skipped(now, "timeout", previous);
      if (result === "wait") {
        if (changed) await this.save(variant.id, { ...record, steps });
        return "waiting";
      }
      // eslint-disable-next-line security/detect-object-injection -- a closed enum of step names
      steps[name] = result;
      changed = true;
      if (result.state === "requested") {
        await this.save(variant.id, { ...record, steps });
        return "waiting";
      }
    }

    await this.save(variant.id, {
      ...record,
      state: "done",
      finishedAt: now.toISOString(),
      steps,
    });
    this.logger.log(
      { runId: run.id, variantId: variant.id, projectId: variant.projectId, steps },
      "autopilot finished a clip shape's edit",
    );
    return "just-finished";
  }

  private async runStep(name: FinishingStep, context: ShapeContext): Promise<StepResult> {
    switch (name) {
      case "autocut":
        return this.autocut(context);
      case "emphasis":
        return this.emphasis(context);
      case "zoom":
        return this.zoom(context);
      case "hook":
        return this.hook(context);
      case "brand":
        return this.brand(context);
      case "music":
        return this.music(context);
    }
  }

  /**
   * Two-speaker layouts (2026-10-01): a clip cut again with both speakers
   * stacked keeps its captions document, and with it the punch-in zooms this
   * pass accepted for the one-window picture - aimed at a face that is no longer
   * where it was, and cropping the other half away. They are turned down
   * (rejected, so the editor still lists them to take back) when the stacked
   * picture lands (`RepurposeClipCompletionHandler`). How many; never throws,
   * since the new picture matters more than its zooms.
   */
  async dropZooms(projectId: string): Promise<number> {
    try {
      const document = await this.documentOf(projectId);
      if (document === undefined) return 0;
      const zooms = document.projection.passes
        .flatMap((pass) => pass.items)
        .filter((item) => item.kind === "zoom" && item.state === "accepted");
      if (zooms.length === 0) return 0;
      await this.apply(projectId, document.revision, [
        {
          opId: newId(),
          type: "DecideItems",
          itemIds: zooms.map((item) => item.itemId),
          state: "rejected",
        },
      ]);
      return zooms.length;
    } catch (error) {
      this.logger.warn(
        { projectId, err: error },
        "could not turn down a re-laid-out clip's zooms; they stay",
      );
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private async autocut(context: ShapeContext): Promise<StepResult> {
    const { variant, previous } = context;
    if (previous?.state === "requested") return this.landPass(context, "cut");
    if (variant.aspect !== "r9x16") {
      const copied = await this.copyCuts(context);
      if (copied !== undefined) return copied;
    }
    if (!(await this.planIncludes(context.run.workspaceId, "autocut"))) {
      return skipped(context.now, "plan");
    }
    return this.startPass(context, "autocut");
  }

  private async zoom(context: ShapeContext): Promise<StepResult> {
    const { variant, previous } = context;
    if (previous?.state === "requested") return this.landPass(context, "zoom");
    if (variant.aspect === "r16x9") return skipped(context.now, "shape");
    // Two people stacked (2026-10-01): a punch-in on one of them is a zoom into
    // the middle of the picture, and crops the other half away.
    if (variant.layout === "stacked") return skipped(context.now, "layout");
    // An audiogram (2026-10-04): a drawn picture, and a punch-in only crops it.
    if (await this.isAudiogram(context.run)) return skipped(context.now, "audiogram");
    if (!(await this.planIncludes(context.run.workspaceId, "reframeZoom"))) {
      return skipped(context.now, "plan");
    }
    return this.startPass(context, "zoom");
  }

  /**
   * One keyword per caption (two in a long one), on captions nobody has
   * emphasised yet, in the document style's default emphasis. Free: it only
   * writes to the document.
   */
  private async emphasis(context: ShapeContext): Promise<StepResult> {
    const { run, variant, now } = context;
    const document = await this.documentOf(variant.projectId);
    if (document === undefined) return skipped(now, "no-document");
    const presetId = await this.defaultEmphasisPreset(run.workspaceId, document.projection);
    if (presetId === undefined) return skipped(now, "style");

    const cuts = acceptedCutRanges(document.projection.passes);
    const words = liveWords(document.chunks);
    const position = new Map(words.map((word, index) => [word.wid, index]));
    const ops: EdgOp[] = [];
    for (const segment of document.projection.segments) {
      if (segment.hidden === true || (segment.emphasis?.length ?? 0) > 0) continue;
      const from = position.get(segment.startWordId);
      const to = position.get(segment.endWordId);
      if (from === undefined || to === undefined) continue;
      // A word the cuts took out is never shown, so it is never the keyword.
      const shown = words
        .slice(from, to + 1)
        .filter((word) => !cuts.some(([start, end]) => word.s < end && word.e > start));
      for (const wordId of chooseEmphasis(shown)) {
        ops.push({
          opId: newId(),
          type: "SetEmphasis",
          segmentId: segment.id,
          wordId: wordId as WordId,
          presetId,
        });
      }
    }
    if (ops.length === 0) return { state: "done", at: now.toISOString(), applied: 0 };
    const applied = await this.apply(variant.projectId, document.revision, ops);
    return { state: "done", at: now.toISOString(), applied };
  }

  /** The hook title, unless the document already has one (a person's, kept). */
  private async hook(context: ShapeContext): Promise<StepResult> {
    const { variant, now } = context;
    const document = await this.documentOf(variant.projectId);
    if (document === undefined) return skipped(now, "no-document");
    const overlays = document.projection.overlays ?? [];
    if (overlays.some((overlay) => overlay.kind === "hook-title")) {
      return { state: "done", at: now.toISOString(), applied: 0 };
    }
    const clip = await this.prisma.repurposeClip.findUnique({
      where: { id: variant.clipId },
      select: { title: true, copy: true },
    });
    const text = clip === null ? "" : hookTextOf(clip.copy, clip.title);
    if (text === "") return skipped(now, "no-text");
    const window = hookWindow(
      document.projection.passes.flatMap((pass) => pass.items),
      primaryDurationOf(document.projection),
    );
    if (window === undefined) return skipped(now, "too-short");
    const applied = await this.apply(variant.projectId, document.revision, [
      {
        opId: newId(),
        type: "SetOverlay",
        // The variant's own id: a repeated or concurrent ask upserts the same title.
        overlay: { id: variant.id, kind: "hook-title", text, ...window },
      },
    ]);
    return { state: "done", at: now.toISOString(), applied };
  }

  /**
   * The brand kit (2026-10-02), for a run that asked for it and a workspace
   * that has one. Free: it only writes to the document. What the document
   * already has is kept — a person's own hook title (Autopilot's is the
   * shape's own id), and any logo or end card — so a repeated ask, or a clip a
   * person has already dressed, gets nothing twice.
   */
  private async brand(context: ShapeContext): Promise<StepResult> {
    const { run, variant, now } = context;
    if (!brandOf(run)) return skipped(now, "off");
    const kits = this.brandKits;
    if (kits === undefined) return skipped(now, "unavailable");
    const kit = await kits.forClips(run.workspaceId);
    if (kit === null) return skipped(now, "no-kit");
    const document = await this.documentOf(variant.projectId);
    if (document === undefined) return skipped(now, "no-document");
    const { projection } = document;
    const ops: EdgOp[] = [];

    const presets = await this.emphasisPresetsOf(run.workspaceId, projection);
    const keyword = keywordPresetId(presets);
    const overrides = brandCaptionOverrides(kit.settings, {
      presets,
      ...(keyword === undefined ? {} : { keywordPresetId: keyword }),
    });
    if (overrides !== undefined) {
      // `SetStyle` replaces the document's overrides wholesale: the kit's go
      // on top of whatever the document already had.
      const inline = projection.styles.inline as { doc?: Record<string, unknown> } | undefined;
      ops.push({
        opId: newId(),
        type: "SetStyle",
        scope: "doc",
        overrides: mergeOverrides(inline?.doc ?? {}, overrides),
      });
    }

    const overlays = projection.overlays ?? [];
    const hook = overlays.find((overlay) => overlay.id === variant.id);
    if (hook?.kind === "hook-title" && hook.appearance === undefined) {
      ops.push({
        opId: newId(),
        type: "SetOverlay",
        overlay: { ...hook, appearance: brandHookAppearance(kit.settings) },
      });
    }

    const durationMs = primaryDurationOf(projection);
    if (!overlays.some((overlay) => overlay.kind === "logo")) {
      const logo = brandLogoOverlay(kit.settings, kit.logo, stableOverlayId(`${variant.id}:logo`), {
        startMs: 0,
        endMs: durationMs,
      });
      if (logo !== undefined) ops.push({ opId: newId(), type: "SetOverlay", overlay: logo });
    }
    if (!overlays.some((overlay) => overlay.kind === "end-card")) {
      const window = endCardWindow(
        projection.passes.flatMap((pass) => pass.items),
        durationMs,
        kit.settings.endCard.durationMs,
      );
      const card =
        window === undefined
          ? undefined
          : brandEndCardOverlay(
              kit.settings,
              kit.logo,
              stableOverlayId(`${variant.id}:end-card`),
              window,
            );
      if (card !== undefined) ops.push({ opId: newId(), type: "SetOverlay", overlay: card });
    }

    if (ops.length === 0) return { state: "done", at: now.toISOString(), applied: 0 };
    const applied = await this.apply(variant.projectId, document.revision, ops);
    return { state: "done", at: now.toISOString(), applied };
  }

  /**
   * The kit's own music (2026-10-04), for a run that asked for the kit and a
   * kit whose music is on and has a track: one bed over the whole clip
   * (`brandMusicPass`, merged as the worker merges any pass). Free: it only
   * writes to the document. A document with a bed already - this one, or one a
   * person took off the clip (a rejected item) - gets nothing more.
   */
  private async music(context: ShapeContext): Promise<StepResult> {
    const { run, variant, now } = context;
    if (!brandOf(run)) return skipped(now, "off");
    const kits = this.brandKits;
    if (kits === undefined) return skipped(now, "unavailable");
    const kit = await kits.forClips(run.workspaceId);
    if (kit === null) return skipped(now, "no-kit");
    if (kit.music === undefined) return skipped(now, "no-music");
    if (!kit.settings.music.enabled) return skipped(now, "music-off");
    const document = await this.documentOf(variant.projectId);
    if (document === undefined) return skipped(now, "no-document");
    const items = document.projection.passes.flatMap((pass) => pass.items);
    if (items.some((item) => item.kind === "music")) {
      return { state: "done", at: now.toISOString(), applied: 0 };
    }
    const bed = brandMusicPass({
      settings: kit.settings,
      music: kit.music,
      durationMs: primaryDurationOf(document.projection),
      // The same on every ask, so a repeated one could only land the same bed.
      passId: stableOverlayId(`${variant.id}:music-pass`),
      itemId: stableOverlayId(`${variant.id}:music`),
    });
    if (bed === undefined) return skipped(now, "too-short");
    const applied = await this.apply(variant.projectId, document.revision, [
      { opId: newId(), type: "MergePass", pass: bed },
    ]);
    return { state: "done", at: now.toISOString(), applied };
  }

  /** Whether the run's source has no picture, so its clips are audiograms (2026-10-04). */
  private async isAudiogram(run: RepurposeRun): Promise<boolean> {
    const source = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { width: true, height: true },
    });
    return source !== null && hasNoPicture(source);
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  /** Starts an autocut or zoom pass; a full lane waits, a plan or credit refusal skips. */
  private async startPass(context: ShapeContext, kind: "autocut" | "zoom"): Promise<StepResult> {
    const passes = this.passes;
    const { run, variant, now } = context;
    if (passes === undefined) return skipped(now, "unavailable");
    // Too late to pay for a pass the video would no longer wait for.
    if (context.overdue) return skipped(now, "timeout");
    try {
      const request = { projectId: variant.projectId, workspaceId: run.workspaceId };
      const started =
        kind === "autocut"
          ? await passes.startAutocut({ ...request, preset: "standard" })
          : await passes.startZoom({ ...request, preset: "standard" });
      this.logger.log(
        { runId: run.id, variantId: variant.id, kind, jobId: started.jobId },
        "autopilot asked for a finishing pass",
      );
      return {
        state: "requested",
        at: now.toISOString(),
        jobId: started.jobId,
        passId: started.passId,
      };
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === "wait") return "wait";
      if (refusal === "error") {
        this.logger.warn(
          { runId: run.id, variantId: variant.id, kind, err: error },
          "a finishing pass could not be started; skipped",
        );
      }
      return skipped(now, refusal);
    }
  }

  /**
   * A requested pass: once its items are in the document, accept what the
   * step takes on the person's behalf. Skipped if its job failed, or it has
   * not landed within {@link FINISHING_STEP_MAX_MS}.
   */
  private async landPass(context: ShapeContext, kind: "cut" | "zoom"): Promise<StepResult> {
    const { variant, now, previous } = context;
    if (previous?.passId === undefined || previous.jobId === undefined) {
      return skipped(now, "lost");
    }
    const document = await this.documentOf(variant.projectId);
    const pass = document?.projection.passes.find((entry) => entry.passId === previous.passId);
    if (document !== undefined && pass !== undefined) {
      let accept: PassItem[];
      if (kind === "cut") {
        accept = pass.items.filter(acceptableCut);
      } else if (variant.layout === "stacked") {
        // Cut again with both speakers stacked since the pass started (a new
        // layout): a punch-in would crop one of them away. Left as proposals.
        accept = [];
      } else {
        const hook = hookWindow(
          document.projection.passes.flatMap((entry) => entry.items),
          primaryDurationOf(document.projection),
        );
        accept = pass.items.filter(
          (item) =>
            item.kind === "zoom" &&
            item.state === "proposed" &&
            (hook === undefined || item.startMs >= hook.endMs),
        );
      }
      const applied =
        accept.length === 0
          ? 0
          : await this.apply(variant.projectId, document.revision, [
              {
                opId: newId(),
                type: "DecideItems",
                itemIds: accept.map((item) => item.itemId),
                state: "accepted",
              },
            ]);
      return { ...previous, state: "done", at: now.toISOString(), applied };
    }

    const job = await this.prisma.job.findUnique({
      where: { id: previous.jobId },
      select: { status: true, finishedAt: true },
    });
    if (job === null) return skipped(now, "lost", previous);
    if (job.status === "failed" || job.status === "cancelled") {
      return skipped(now, "failed", previous);
    }
    // Finished, yet its items never reached the document (its merge was
    // refused): a short grace for a completion still landing, then move on.
    if (
      job.status === "succeeded" &&
      job.finishedAt !== null &&
      now.getTime() - job.finishedAt.getTime() > LANDING_GRACE_MS
    ) {
      return skipped(now, "lost", previous);
    }
    if (now.getTime() - Date.parse(previous.at) > FINISHING_STEP_MAX_MS) {
      return skipped(now, "timeout", previous);
    }
    // Queued, running, or succeeded with its items still landing.
    return "wait";
  }

  /**
   * A shape other than 9:16 takes the 9:16 shape's cuts: the same moment cut
   * the same way, so every format runs the same length, and the pass is paid
   * for once per clip. `undefined` when that is not possible (no 9:16 shape, or
   * timelines that do not match): the shape then runs its own pass.
   */
  private async copyCuts(context: ShapeContext): Promise<StepResult | undefined> {
    const { variant, now } = context;
    const vertical = await this.prisma.clipVariant.findUnique({
      where: { clipId_aspect: { clipId: variant.clipId, aspect: "r9x16" } },
      select: { id: true, projectId: true, finishing: true, latestExportId: true },
    });
    if (vertical === null) return undefined;
    const verticalRecord = finishingRecordOf(vertical.finishing);
    // A 9:16 shape whose video was made before finishing existed is never
    // finished: nothing to take, so this shape cuts its own.
    if (verticalRecord === null && vertical.latestExportId !== null) return undefined;
    const verticalCut = verticalRecord?.steps.autocut;
    // The 9:16 shape is still being finished: its cuts are on their way (the
    // whole pass gives up after FINISHING_MAX_MS, so this never waits for ever).
    if (verticalCut === undefined || verticalCut.state === "requested") return "wait";
    if (verticalCut.state === "skipped") {
      return skipped(now, verticalCut.reason ?? "skipped", { copiedFrom: vertical.id });
    }

    const [mine, theirs] = await Promise.all([
      this.documentOf(variant.projectId),
      this.documentOf(vertical.projectId),
    ]);
    if (mine === undefined || theirs === undefined) return undefined;
    if (
      Math.abs(primaryDurationOf(mine.projection) - primaryDurationOf(theirs.projection)) >
      SAME_TIMELINE_MS
    ) {
      return undefined;
    }
    const cuts = theirs.projection.passes
      .flatMap((pass) => pass.items)
      .filter((item): item is CutPassItem => item.kind === "cut" && item.state === "accepted");
    const alreadyCopied = mine.projection.passes.some((pass) => pass.engine === COPIED_ENGINE);
    if (cuts.length === 0 || alreadyCopied) {
      return { state: "done", at: now.toISOString(), applied: 0, copiedFrom: vertical.id };
    }
    const passId = newId();
    const pass: Pass = {
      passId,
      type: "autocut",
      engine: COPIED_ENGINE,
      params: { copiedFromProjectId: vertical.projectId },
      status: "ready",
      items: cuts.map((item) => ({
        itemId: newId(),
        passId,
        kind: "cut",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: {},
        ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        state: "accepted",
      })),
    };
    const applied = await this.apply(variant.projectId, mine.revision, [
      { opId: newId(), type: "MergePass", pass },
    ]);
    return {
      state: "done",
      at: now.toISOString(),
      applied: applied === 0 ? 0 : cuts.length,
      copiedFrom: vertical.id,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async planIncludes(
    workspaceId: string,
    pass: "autocut" | "reframeZoom",
  ): Promise<boolean> {
    const view = await this.entitlements.forWorkspace(workspaceId);
    const passes = view.entitlements["passes"];
    if (typeof passes !== "object" || passes === null) return false;
    // eslint-disable-next-line security/detect-object-injection -- a closed union of two keys
    return (passes as Record<string, unknown>)[pass] === true;
  }

  /** The document and its words, or `undefined` when the project has none yet. */
  /**
   * The document, its words, and the revision to write against — the row's
   * own, read first, so a write is never based on anything newer than it saw.
   */
  private async documentOf(
    projectId: string,
  ): Promise<
    { projection: EdgProjection; chunks: TranscriptChunk[]; revision: number } | undefined
  > {
    const row = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true, revision: true },
    });
    if (row === null) return undefined;
    const projection = await this.edgRepository.projectionOf(row.id);
    const chunks = await this.edgRepository.loadChunks(projection.transcript.transcriptId);
    return { projection, chunks, revision: row.revision };
  }

  /**
   * The emphasis the keywords get: the first of the style's presets that reads
   * as a keyword ({@link keywordPresetId}), from the document's own presets
   * when it overrides them (an override replaces the list), else the style's.
   * The first preset is what "Emphasise word" uses, so it is usually that one.
   */
  private async defaultEmphasisPreset(
    workspaceId: string,
    projection: EdgProjection,
  ): Promise<string | undefined> {
    return keywordPresetId(await this.emphasisPresetsOf(workspaceId, projection));
  }

  /**
   * The emphasis presets the document's captions wear: the document's own list
   * when it overrides them (an override replaces the list), else the style's.
   */
  private async emphasisPresetsOf(
    workspaceId: string,
    projection: EdgProjection,
  ): Promise<Record<string, unknown>[]> {
    const inline = projection.styles.inline as { doc?: { emphasisPresets?: unknown } } | undefined;
    const own = inline?.doc?.emphasisPresets;
    const presets = Array.isArray(own)
      ? own
      : ((
          (await resolveStyleSnapshot(this.prisma, workspaceId, projection)).styles[
            projection.styles.defaultStyleId
          ] as { emphasisPresets?: unknown } | undefined
        )?.emphasisPresets ?? []);
    return (Array.isArray(presets) ? (presets as unknown[]) : []).filter(
      (preset): preset is Record<string, unknown> =>
        typeof preset === "object" && preset !== null && !Array.isArray(preset),
    );
  }

  /** Applies worker ops; how many landed. A refused op is logged, never thrown. */
  private async apply(
    projectId: string,
    baseRevision: number,
    ops: readonly EdgOp[],
  ): Promise<number> {
    const response = await this.edg.applyWorkerOps({
      projectId,
      baseRevision,
      ops,
      clientOpIds: [],
    });
    if (response.rejected.length > 0) {
      this.logger.warn(
        { projectId, rejected: response.rejected.slice(0, 5), total: response.rejected.length },
        "some finishing ops were refused by the document",
      );
    }
    return response.applied.length + response.rebased.length;
  }

  private async save(variantId: string, record: FinishingRecord): Promise<void> {
    await this.prisma.clipVariant.update({
      where: { id: variantId },
      data: { finishing: record as unknown as Prisma.InputJsonValue },
    });
  }
}

/** The engine a 9:16 shape's cuts are copied under, so a copy is never made twice. */
const COPIED_ENGINE = "autocut@9x16";

function skipped(
  now: Date,
  reason: string,
  extra: Partial<FinishingStepRecord> = {},
): FinishingStepRecord {
  return { ...extra, state: "skipped", at: now.toISOString(), reason };
}

/**
 * What a refused pass means for the step: a full lane is a wait, a plan or
 * credit refusal a skip, anything else a skip worth logging.
 */
function refusalOf(error: unknown): "wait" | "plan" | "credits" | "not-ready" | "error" {
  if (!(error instanceof AppException)) return "error";
  if (error.code === JOB_ERROR_CODES.concurrencyCap || error.code === JOB_ERROR_CODES.enqueueCap) {
    return "wait";
  }
  if (error.code.startsWith("credits/") || error.getStatus() === HttpStatus.PAYMENT_REQUIRED) {
    return "credits";
  }
  if (error.code.startsWith("entitlement/") || error.getStatus() === HttpStatus.FORBIDDEN) {
    return "plan";
  }
  // Media, transcript or proxy not there: the step cannot run on this shape.
  if (error.code.startsWith("pass/") || error.code.startsWith("passes/")) return "not-ready";
  return "error";
}

/**
 * Effects a keyword can wear on every caption: a colour, a glow, an underline,
 * an outline. Not `shake` — a jolt on every line is noise, not emphasis — and
 * not `highlight`, whose marker is painted in the same colour as the word
 * (render-core's `emphasisGround`), so the keyword would disappear.
 */
const KEYWORD_EFFECTS: ReadonlySet<unknown> = new Set([
  undefined,
  "none",
  "glow",
  "underline",
  "outline",
]);

/** The first preset in `presets` that reads as a keyword, or `undefined`. */
export function keywordPresetId(presets: unknown): string | undefined {
  if (!Array.isArray(presets)) return undefined;
  for (const preset of presets as unknown[]) {
    if (typeof preset !== "object" || preset === null) continue;
    const { id, effect } = preset as { id?: unknown; effect?: unknown };
    if (typeof id === "string" && id !== "" && KEYWORD_EFFECTS.has(effect)) return id;
  }
  return undefined;
}

function primaryDurationOf(projection: EdgProjection): number {
  const primary = projection.media.find((media) => media.role === "primary");
  return primary?.durationMs ?? 0;
}

function acceptedCutRanges(passes: readonly Pass[]): [number, number][] {
  return passes
    .flatMap((pass) => pass.items)
    .filter((item) => item.kind === "cut" && item.state === "accepted")
    .map((item) => [item.startMs, item.endMs]);
}

function liveWords(
  chunks: readonly TranscriptChunk[],
): { wid: string; t: string; s: number; e: number; filler?: boolean }[] {
  return chunks
    .flatMap((chunk) => chunk.words)
    .filter((word) => word.deleted !== true)
    .map((word) => ({
      wid: word.wid,
      t: word.t,
      s: word.s,
      e: word.e,
      ...(word.filler === undefined ? {} : { filler: word.filler }),
    }));
}
