import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import { quote, type Env } from "@montaj/config";
import { CLIP_LENGTH_PRESETS, ClipCopySchema } from "@montaj/repurpose-contracts";

import { runDefaultsSetupSchema } from "./run-results.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { ENV } from "../../config/config.module.js";
import { newestChunkRows } from "../../edg/chunk-rows.js";
import { StylesService } from "../../styles/styles.service.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import { ClipFinishing, finishingRecordOf } from "../clip-finishing.js";
import {
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  automationOf,
  autopilotClipCount,
} from "../repurpose.constants.js";
import { RepurposeService } from "../repurpose.service.js";

import type { EstimateQuery, RunDefaultsSetup } from "./run-results.dto.js";
import type { SnapWord } from "../steering.js";
import type { Prisma, RepurposeRun } from "@prisma/client";

/** Every Autopilot clip is made in these many shapes (9:16, 4:5, 1:1, 16:9). */
const SHAPES_PER_CLIP = 4;

/** A typical clip of a length preset, mid-band; medium when none was asked for. */
function typicalClipMs(clipLength: EstimateQuery["clipLength"]): number {
  const band = CLIP_LENGTH_PRESETS[clipLength ?? "medium"];
  return (band.minDurationMs + band.maxDurationMs) / 2;
}

/** What a new run would cost (2026-10-01): the start form shows it as it is filled in. */
export interface RunEstimate {
  /** What the workspace has to spend now, other runs' pending transcriptions off. */
  readonly creditsLeft: number;
  /** The most of a video the plan processes in one run. */
  readonly planWindowMs: number;
  /** The most this workspace can process now: the plan's window cut to what its credits pay for; 0 when not a minute. */
  readonly windowMs: number;
  /** The most of a video a run may look at at all. */
  readonly maxSourceDurationMs: number;
  /** How much of this video would be processed (the window when the length is not known). */
  readonly processMs: number;
  /** The video is longer than what would be processed (only known for an upload). */
  readonly trimmed: boolean;
  /** Finding moments: transcription of what is processed, 1 credit a minute. */
  readonly processCredits: number;
  /**
   * Autopilot's finished videos, roughly: about one clip per two minutes, each
   * in four shapes with captions burned in, at the cloud render rate. Null on
   * a run whose person makes the clips.
   */
  readonly finishedVideos: {
    readonly clips: number;
    readonly videos: number;
    readonly credits: number;
  } | null;
  /** The two together, rounded up. */
  readonly totalCredits: number;
}

/** A workspace's saved setup for new runs, and when it was saved; nulls when none is. */
export interface RunDefaultsView {
  readonly setup: RunDefaultsSetup | null;
  readonly savedAt: string | null;
}

/** The `workspaces.settings` key the default setup is kept under. */
export const RUN_DEFAULTS_KEY = "runDefaults";

/** One line of a clip's transcript, on the original video's clock. */
export interface TranscriptLine {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** A gap this long between two words starts a new line. */
const LINE_GAP_MS = 800;
/** A line never holds more words than this. */
const LINE_MAX_WORDS = 14;

/**
 * The run's results page (2026-10-01, OpusClip parity): a clip's title edited
 * in place, Autopilot's hook titles switched off or back on for a whole run,
 * what a new run would cost, and a clip's words on the original's clock.
 */
@Injectable()
export class RepurposeResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly finishing: ClipFinishing,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    @Inject(ENV) private readonly env: Env,
    private readonly styles: StylesService,
  ) {}

  /**
   * The workspace's default setup for new runs (2026-10-01), as the start form
   * opens on it. A saved setup that no longer passes (a field renamed, say)
   * reads as none rather than failing the form.
   */
  async defaults(workspaceId: string): Promise<RunDefaultsView> {
    await this.assertAvailable(workspaceId);
    const settings = await this.settingsOf(workspaceId);
    const saved = settings["runDefaults"];
    if (typeof saved !== "object" || saved === null) return { setup: null, savedAt: null };
    const record = saved as Record<string, unknown>;
    const setup = runDefaultsSetupSchema.safeParse(record["setup"]);
    if (!setup.success) return { setup: null, savedAt: null };
    return {
      setup: setup.data,
      savedAt: typeof record["savedAt"] === "string" ? record["savedAt"] : null,
    };
  }

  /**
   * Saves `setup` as the workspace's default for new runs (editors and up). Its
   * caption look must be one the workspace can use, as a run's must; other
   * settings are kept (`workspaces.settings` is merged, never replaced).
   */
  async saveDefaults(
    workspaceId: string,
    userId: string,
    setup: RunDefaultsSetup,
  ): Promise<RunDefaultsView> {
    await this.assertAvailable(workspaceId);
    const catalogue = await this.styles.list(workspaceId);
    if (!catalogue.some((style) => style.id === setup.caption.styleId)) {
      throw new AppException(
        REPURPOSE_ERRORS.styleUnknown,
        "That caption look is not available. Choose another one.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const savedAt = new Date().toISOString();
    const settings = await this.settingsOf(workspaceId);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        settings: {
          ...settings,
          [RUN_DEFAULTS_KEY]: { setup, savedAt, savedBy: userId },
        } as Prisma.InputJsonObject,
      },
    });
    await this.audit.record({
      action: "repurpose.defaults.saved",
      resource: "workspace",
      resourceId: workspaceId,
      actorId: userId,
      workspaceId,
      data: { styleId: setup.caption.styleId, automation: setup.automation ?? "manual" },
    });
    return { setup, savedAt };
  }

  /** Back to the product's own defaults for new runs. */
  async clearDefaults(workspaceId: string, userId: string): Promise<RunDefaultsView> {
    await this.assertAvailable(workspaceId);
    const settings = await this.settingsOf(workspaceId);
    if (RUN_DEFAULTS_KEY in settings) {
      const { [RUN_DEFAULTS_KEY]: _dropped, ...rest } = settings;
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { settings: rest as Prisma.InputJsonObject },
      });
      await this.audit.record({
        action: "repurpose.defaults.cleared",
        resource: "workspace",
        resourceId: workspaceId,
        actorId: userId,
        workspaceId,
      });
    }
    return { setup: null, savedAt: null };
  }

  /**
   * A moment's title, as a person wrote it: the moment's own, its clip's, and
   * the title in their words to post (marked as the person's). The clip's
   * files and its posts are named after it from now on; a hook title already
   * on the video is left as it is.
   */
  async retitle(
    workspaceId: string,
    userId: string,
    runId: string,
    candidateId: string,
    title: string,
  ): Promise<{ readonly candidateId: string; readonly title: string }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const candidate = await this.prisma.clipCandidate.findFirst({
      where: { id: candidateId, runId: run.id },
      select: { id: true, title: true, copy: true },
    });
    if (candidate === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that moment.",
        HttpStatus.NOT_FOUND,
      );
    }
    const clip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
      select: { id: true, copy: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.clipCandidate.update({
        where: { id: candidate.id },
        data: { title, ...retitledCopy(candidate.copy, title) },
      });
      if (clip !== null) {
        await tx.repurposeClip.update({
          where: { id: clip.id },
          data: { title, ...retitledCopy(clip.copy, title) },
        });
      }
    });
    await this.audit.record({
      action: "repurpose.candidate.retitled",
      resource: "clip_candidate",
      resourceId: candidate.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, clipId: clip?.id ?? null },
    });
    return { candidateId: candidate.id, title };
  }

  /**
   * Autopilot's hook titles for the whole run, off or back on (OpusClip's
   * "Auto headline ... Disable it"). Off takes Autopilot's own title out of
   * every shape of every clip and keeps new clips from getting one; on puts it
   * back on every finished shape. A hook title a person added is never
   * touched. Each change is an edit, so each shape's captioned video is made
   * again a minute later, as after any edit.
   */
  async setHookTitles(
    workspaceId: string,
    userId: string,
    runId: string,
    enabled: boolean,
  ): Promise<{ readonly enabled: boolean; readonly changed: number }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (automationOf(run) !== "auto") {
      throw new AppException(
        REPURPOSE_ERRORS.hookTitlesManual,
        "Hook titles are added by Autopilot. This video's clips were made by hand.",
        HttpStatus.CONFLICT,
      );
    }
    const config = isRecord(run.config) ? run.config : {};
    const updated = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: { config: { ...config, hookTitles: enabled } as Prisma.InputJsonValue },
    });
    const variants = await this.prisma.clipVariant.findMany({
      where: { clip: { runId: run.id } },
      select: {
        id: true,
        clipId: true,
        projectId: true,
        aspect: true,
        finishing: true,
        layout: true,
      },
    });
    let changed = 0;
    for (const variant of variants) {
      if (enabled) {
        // A shape still being finished gets it from its own pass.
        if (finishingRecordOf(variant.finishing)?.state !== "done") continue;
        if (await this.finishing.restoreAutopilotHook(updated, variant)) changed += 1;
      } else if (await this.finishing.removeAutopilotHook(variant)) {
        changed += 1;
      }
    }
    await this.audit.record({
      action: enabled ? "repurpose.hook_titles.enabled" : "repurpose.hook_titles.disabled",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: { shapesChanged: changed },
    });
    return { enabled, changed };
  }

  /** What a new run would cost, for the start form (never refuses; see {@link RunEstimate}). */
  async estimate(workspaceId: string, input: EstimateQuery): Promise<RunEstimate> {
    await this.assertAvailable(workspaceId);
    const budget = await this.runs.budgetView(workspaceId);
    const wanted = input.durationMs ?? budget.planWindowMs;
    const processMs = Math.min(wanted, budget.windowMs);
    const processCredits = creditsOf(quote("transcription", processMs / 60_000).costTenths);
    let finishedVideos: RunEstimate["finishedVideos"] = null;
    if (input.automation === "auto" && processMs > 0) {
      const clips = autopilotClipCount(processMs);
      const videos = clips * SHAPES_PER_CLIP;
      const minutes = (videos * typicalClipMs(input.clipLength)) / 60_000;
      finishedVideos = {
        clips,
        videos,
        credits: creditsOf(quote("cloudRender", minutes).costTenths),
      };
    }
    return {
      creditsLeft: creditsOf(Math.max(0, budget.availableTenths)),
      planWindowMs: budget.planWindowMs,
      windowMs: budget.windowMs,
      maxSourceDurationMs: budget.maxSourceDurationMs,
      processMs,
      trimmed: input.durationMs !== undefined && input.durationMs > processMs,
      processCredits,
      finishedVideos,
      totalCredits: Math.ceil(processCredits + (finishedVideos?.credits ?? 0)),
    };
  }

  /**
   * A moment's words as lines on the ORIGINAL video's clock (OpusClip's
   * "[01:34 - 02:04]"): a run over part of a video has its window's start
   * added back. Lines break at a pause, at the end of a sentence, or at
   * {@link LINE_MAX_WORDS} words.
   */
  async transcript(
    workspaceId: string,
    runId: string,
    candidateId: string,
  ): Promise<{ readonly offsetMs: number; readonly lines: TranscriptLine[] }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const candidate = await this.prisma.clipCandidate.findFirst({
      where: { id: candidateId, runId: run.id },
      select: { startMs: true, endMs: true },
    });
    if (candidate === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that moment.",
        HttpStatus.NOT_FOUND,
      );
    }
    const lines = await runTranscriptLines(this.prisma, run, [{ id: candidateId, ...candidate }]);
    return { offsetMs: run.windowStartMs ?? 0, lines: lines.get(candidateId) ?? [] };
  }

  /** 404 unless the run is the workspace's and the clips surface is on for it. */
  async assertRun(workspaceId: string, runId: string): Promise<void> {
    await this.assertAvailable(workspaceId);
    await this.requireRun(workspaceId, runId);
  }

  // -------------------------------------------------------------------------

  private async settingsOf(workspaceId: string): Promise<Record<string, unknown>> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const settings = workspace?.settings;
    return typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  }

  private async requireRun(workspaceId: string, runId: string): Promise<RepurposeRun> {
    const run = await this.prisma.repurposeRun.findFirst({ where: { id: runId, workspaceId } });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }

  /** The clips surface's rule, as every repurpose service states it: 404 while it is off. */
  private async assertAvailable(workspaceId: string): Promise<void> {
    const override = this.env.FEATURE_FLAGS_JSON[REPURPOSE_FLAGS.flow];
    const enabled =
      typeof override === "boolean"
        ? override
        : (
            (await this.entitlements.forWorkspace(workspaceId)).entitlements.flags as
              Record<string, boolean> | undefined
          )?.[REPURPOSE_FLAGS.flow] === true;
    if (enabled) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function creditsOf(tenths: number): number {
  return Math.round(tenths) / 10;
}

/** The copy with a person's title, when there is whole copy to change; nothing otherwise. */
function retitledCopy(copy: unknown, title: string): { copy?: Prisma.InputJsonValue } {
  const parsed = ClipCopySchema.safeParse(copy);
  if (!parsed.success) return {};
  return { copy: { ...parsed.data, title, source: "person" } as unknown as Prisma.InputJsonValue };
}

/**
 * Several moments' words as lines on the original video's clock, from one read
 * of the run's newest transcript (2026-10-01): the clip view asks for one, the
 * example run (`example/example-run.service.ts`) for every clip at once. A
 * moment with no words, or a run with no transcript, has no lines.
 */
export async function runTranscriptLines(
  prisma: PrismaService,
  run: Pick<RepurposeRun, "sourceProjectId" | "windowStartMs">,
  moments: readonly { readonly id: string; readonly startMs: number; readonly endMs: number }[],
): Promise<Map<string, TranscriptLine[]>> {
  const byMoment = new Map<string, TranscriptLine[]>();
  if (moments.length === 0) return byMoment;
  const transcript = await prisma.transcript.findFirst({
    where: { projectId: run.sourceProjectId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (transcript === null) return byMoment;
  const offsetMs = run.windowStartMs ?? 0;
  const words = (await newestChunkRows(prisma, transcript.id))
    .flatMap((chunk) => (chunk.words as unknown as SnapWord[] | null) ?? [])
    .filter((word) => word.deleted !== true && typeof word.t === "string");
  for (const moment of moments) {
    const inside = words.filter(
      (word) => word.s >= moment.startMs - 50 && word.e <= moment.endMs + 50,
    );
    byMoment.set(moment.id, linesOf(inside, offsetMs));
  }
  return byMoment;
}

/** Words into lines (see {@link RepurposeResultsService.transcript}). */
export function linesOf(words: readonly SnapWord[], offsetMs = 0): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: SnapWord[] = [];
  const flush = (): void => {
    const first = current.at(0);
    const last = current.at(-1);
    if (first === undefined || last === undefined) return;
    lines.push({
      startMs: first.s + offsetMs,
      endMs: last.e + offsetMs,
      text: current
        .map((word) => (word.t ?? "").trim())
        .filter((text) => text !== "")
        .join(" "),
    });
    current = [];
  };
  for (const word of words) {
    const previous = current.at(-1);
    if (previous !== undefined && word.s - previous.e > LINE_GAP_MS) flush();
    current.push(word);
    const ends = /[.!?।]["')\]]?$/.test((word.t ?? "").trim());
    if (current.length >= LINE_MAX_WORDS || (ends && current.length >= 4)) flush();
  }
  flush();
  return lines;
}
