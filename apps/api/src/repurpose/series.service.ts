import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";
import type { EdgOp, HookTitleOverlay } from "@montaj/edg/schemas";
import { SERIES_LIMITS } from "@montaj/repurpose-contracts";

import { finishingInProgress } from "./clip-finishing.js";
import { clipIdsOf } from "./compilation-plan.js";
import { SERIES_ERRORS, type CreateSeriesInput } from "./compilations.dto.js";
import { REPURPOSE_ERRORS, REPURPOSE_FLAGS } from "./repurpose.constants.js";
import { hookOverlayOf, planLabelRemoval, planSeriesLabels } from "./series-labels.js";
import { isRemoved } from "./steering.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { EdgRepository, EdgService } from "../edg/index.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { Prisma, RepurposeRun, RepurposeSeries } from "@prisma/client";

/** One labelled clip shape, as `repurpose_series.labels` records it. */
export interface SeriesLabelEntry {
  readonly variantId: string;
  readonly projectId: string;
  readonly clipId: string;
  readonly part: number;
  /** Autopilot's hook title the part label took the place of. */
  readonly replaced: HookTitleOverlay | null;
  /** The labels written, by overlay id. */
  readonly added: readonly string[];
}

/**
 * A series as `GET .../series` returns it (2026-10-03): its clips in part
 * order, and for each how many of its shapes carry their labels and how many
 * are still to (a shape still being cut or finished takes them once it is).
 */
export interface SeriesView {
  readonly id: string;
  readonly runId: string;
  readonly clipIds: readonly string[];
  readonly parts: readonly {
    readonly clipId: string;
    readonly part: number;
    readonly labelled: number;
    readonly pending: number;
  }[];
  readonly createdAt: string;
}

/** The variant slice labelling reads. */
interface VariantRow {
  readonly id: string;
  readonly clipId: string;
  readonly projectId: string;
  readonly finishing: Prisma.JsonValue | null;
}

/**
 * Consecutive clips posted as a numbered series (2026-10-03): "Make a series"
 * on the run page. Each clip's every shape gets "Part N of M" over its first
 * seconds and, but the last, "Part N+1 next" before its end (`series-labels.ts`),
 * as edits to that shape's editing document - so the captioned videos are made
 * again through the ordinary path (`captionClips`: a new revision, then
 * `CAPTIONED_QUIET_MS`), and an export from the editor carries them too.
 *
 * The parts are numbered in the order the clips play in the video. A clip is
 * in one series at a time. A shape still being cut or finished when the series
 * is made takes its labels once it is ready ({@link reconcile}, run with the
 * run's clips), so a clip's later formats are labelled like its first.
 * "Remove series labels" takes them off every shape and puts back what they
 * replaced.
 */
@Injectable()
export class RepurposeSeriesService {
  private readonly logger = new Logger(RepurposeSeriesService.name);
  /** Series being labelled by this process now: one pass at a time each. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly edg: EdgService,
    private readonly edgRepository: EdgRepository,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(
    workspaceId: string,
    runId: string,
  ): Promise<{ readonly runId: string; readonly series: SeriesView[] }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const rows = await this.prisma.repurposeSeries.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
    });
    return { runId: run.id, series: await Promise.all(rows.map((row) => this.viewOf(row))) };
  }

  async create(
    workspaceId: string,
    userId: string,
    runId: string,
    input: CreateSeriesInput,
  ): Promise<SeriesView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);

    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id, id: { in: [...input.clipIds] } },
      select: {
        id: true,
        mezzanineKey: true,
        sourceStartMs: true,
        createdAt: true,
        candidate: { select: { state: true } },
      },
    });
    const ready = clips.filter((clip) => clip.mezzanineKey !== null && !isRemoved(clip.candidate));
    const readyIds = new Set(ready.map((clip) => clip.id));
    const notReady = input.clipIds.filter((id) => !readyIds.has(id));
    if (notReady.length > 0 || ready.length < SERIES_LIMITS.minClips) {
      throw new AppException(
        SERIES_ERRORS.clipsNotReady,
        "Every clip in a series has to be made first.",
        HttpStatus.CONFLICT,
        { clipIds: notReady },
      );
    }

    const taken = new Set(
      (await this.prisma.repurposeSeries.findMany({ where: { runId: run.id } })).flatMap((row) =>
        clipIdsOf(row.clipIds),
      ),
    );
    const clash = input.clipIds.filter((id) => taken.has(id));
    if (clash.length > 0) {
      throw new AppException(
        SERIES_ERRORS.clipTaken,
        "A clip can be in one series at a time. Remove its labels from the other series first.",
        HttpStatus.CONFLICT,
        { clipIds: clash },
      );
    }

    // Part 1 is the clip that comes first in the video.
    const ordered = [...ready].sort(
      (a, b) => a.sourceStartMs - b.sourceStartMs || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const series = await this.prisma.repurposeSeries.create({
      data: {
        id: ulid(),
        runId: run.id,
        workspaceId: run.workspaceId,
        clipIds: ordered.map((clip) => clip.id),
        labels: [],
        createdBy: userId,
      },
    });
    await this.label(series);

    await this.audit.record({
      action: "repurpose.series.created",
      resource: "repurpose_series",
      resourceId: series.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, clips: ordered.length },
    });
    return this.viewOf(await this.fresh(series.id));
  }

  /** "Remove series labels": every shape's labels come off, and what they replaced goes back. */
  async remove(
    workspaceId: string,
    userId: string,
    runId: string,
    seriesId: string,
  ): Promise<{ readonly id: string; readonly restored: number }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const series = await this.prisma.repurposeSeries.findFirst({
      where: { id: seriesId, runId: run.id },
    });
    if (series === null) {
      throw new AppException(
        SERIES_ERRORS.notFound,
        "We could not find that series.",
        HttpStatus.NOT_FOUND,
      );
    }

    let restored = 0;
    for (const entry of labelEntriesOf(series.labels)) {
      try {
        const document = await this.documentOf(entry.projectId);
        if (document === undefined) continue;
        const ops = planLabelRemoval({
          added: entry.added,
          replaced: entry.replaced,
          overlays: document.projection.overlays ?? [],
        });
        if (ops.length === 0) continue;
        await this.apply(entry.projectId, document.revision, ops);
        restored += 1;
      } catch (error) {
        // A shape whose project is gone has nothing to take off.
        this.logger.warn(
          { seriesId: series.id, projectId: entry.projectId, err: error },
          "could not take a series' labels off a clip shape",
        );
      }
    }
    await this.prisma.repurposeSeries.deleteMany({ where: { id: series.id } });

    await this.audit.record({
      action: "repurpose.series.removed",
      resource: "repurpose_series",
      resourceId: series.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, shapes: restored },
    });
    return { id: series.id, restored };
  }

  /**
   * Label every shape of a run's series that has not been yet: a format cut
   * after the series was made, or a shape that was still being finished. With
   * the run's clip reconcile; never throws.
   */
  async reconcile(runId: string): Promise<void> {
    try {
      const rows = await this.prisma.repurposeSeries.findMany({ where: { runId } });
      for (const series of rows) await this.label(series);
    } catch (error) {
      this.logger.warn({ runId, err: error }, "could not label a run's series this pass");
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Labels the series' shapes that have none yet and can take them: a shape
   * whose document exists and whose Autopilot finishing (if any) is done -
   * finishing writes the hook title the part label takes the place of.
   */
  private async label(series: RepurposeSeries): Promise<void> {
    if (this.busy.has(series.id)) return;
    this.busy.add(series.id);
    try {
      const clipIds = clipIdsOf(series.clipIds);
      const entries = labelEntriesOf(series.labels);
      const done = new Set(entries.map((entry) => entry.variantId));
      const variants: VariantRow[] = await this.prisma.clipVariant.findMany({
        where: { clipId: { in: clipIds } },
        select: { id: true, clipId: true, projectId: true, finishing: true },
      });
      const added: SeriesLabelEntry[] = [];
      for (const variant of variants) {
        if (done.has(variant.id) || finishingInProgress(variant.finishing)) continue;
        const part = clipIds.indexOf(variant.clipId) + 1;
        if (part < 1) continue;
        try {
          const entry = await this.labelShape(variant, part, clipIds.length);
          if (entry !== undefined) added.push(entry);
        } catch (error) {
          // One shape that cannot take its labels now is tried again next pass.
          this.logger.warn(
            { seriesId: series.id, variantId: variant.id, err: error },
            "could not label a series' clip shape; the next pass tries again",
          );
        }
      }
      if (added.length === 0) return;
      await this.prisma.repurposeSeries.update({
        where: { id: series.id },
        data: { labels: [...entries, ...added] as unknown as Prisma.InputJsonValue },
      });
      this.logger.log(
        { seriesId: series.id, runId: series.runId, shapes: added.length },
        "labelled a series' clip shapes",
      );
    } finally {
      this.busy.delete(series.id);
    }
  }

  /** One shape's labels; `undefined` when it cannot take them yet (no document). */
  private async labelShape(
    variant: VariantRow,
    part: number,
    parts: number,
  ): Promise<SeriesLabelEntry | undefined> {
    const document = await this.documentOf(variant.projectId);
    if (document === undefined) return undefined;
    const primary = document.projection.media.find((media) => media.role === "primary");
    const plan = planSeriesLabels({
      variantId: variant.id,
      part,
      parts,
      overlays: document.projection.overlays ?? [],
      items: document.projection.passes.flatMap((pass) => pass.items),
      durationMs: primary?.durationMs ?? 0,
    });
    let landed = new Set<string>();
    if (plan.ops.length > 0) {
      landed = await this.apply(variant.projectId, document.revision, plan.ops);
    }
    // Only what the document took is recorded, so a removal takes off what is there.
    const opFor = (overlayId: string): string | undefined =>
      plan.ops.find((op) => op.type === "SetOverlay" && op.overlay.id === overlayId)?.opId;
    const removal = plan.ops.find((op) => op.type === "RemoveOverlay");
    return {
      variantId: variant.id,
      projectId: variant.projectId,
      clipId: variant.clipId,
      part,
      replaced:
        plan.replaced !== null && removal !== undefined && landed.has(removal.opId)
          ? plan.replaced
          : null,
      added: plan.added.filter((id) => {
        const opId = opFor(id);
        return opId !== undefined && landed.has(opId);
      }),
    };
  }

  private async documentOf(projectId: string): Promise<
    | {
        readonly projection: Awaited<ReturnType<EdgRepository["projectionOf"]>>;
        readonly revision: number;
      }
    | undefined
  > {
    const row = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true, revision: true },
    });
    if (row === null) return undefined;
    return { projection: await this.edgRepository.projectionOf(row.id), revision: row.revision };
  }

  /** Applies ops as the worker path does (rebased, never refused as stale); the op ids that landed. */
  private async apply(
    projectId: string,
    baseRevision: number,
    ops: readonly EdgOp[],
  ): Promise<Set<string>> {
    const response = await this.edg.applyWorkerOps({
      projectId,
      baseRevision,
      ops,
      clientOpIds: [],
    });
    if (response.rejected.length > 0) {
      this.logger.warn(
        { projectId, rejected: response.rejected.slice(0, 5) },
        "a series label was refused by the document",
      );
    }
    return new Set([...response.applied, ...response.rebased]);
  }

  private async viewOf(series: RepurposeSeries): Promise<SeriesView> {
    const clipIds = clipIdsOf(series.clipIds);
    const entries = labelEntriesOf(series.labels);
    const variants = await this.prisma.clipVariant.findMany({
      where: { clipId: { in: clipIds } },
      select: { id: true, clipId: true },
    });
    const labelled = new Set(entries.map((entry) => entry.variantId));
    return {
      id: series.id,
      runId: series.runId,
      clipIds,
      parts: clipIds.map((clipId, index) => {
        const shapes = variants.filter((variant) => variant.clipId === clipId);
        const done = shapes.filter((variant) => labelled.has(variant.id)).length;
        return { clipId, part: index + 1, labelled: done, pending: shapes.length - done };
      }),
      createdAt: series.createdAt.toISOString(),
    };
  }

  private async fresh(id: string): Promise<RepurposeSeries> {
    return this.prisma.repurposeSeries.findUniqueOrThrow({ where: { id } });
  }

  /** The clips' rule (`RepurposeClipsService`): 404 while `repurpose_flow` is off. */
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
}

/** `repurpose_series.labels` as stored; a malformed entry is skipped, never thrown. */
export function labelEntriesOf(value: unknown): SeriesLabelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SeriesLabelEntry[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry["variantId"] !== "string" ||
      typeof entry["projectId"] !== "string" ||
      typeof entry["clipId"] !== "string" ||
      typeof entry["part"] !== "number"
    ) {
      continue;
    }
    const added = Array.isArray(entry["added"])
      ? (entry["added"] as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    entries.push({
      variantId: entry["variantId"],
      projectId: entry["projectId"],
      clipId: entry["clipId"],
      part: entry["part"],
      replaced: hookOverlayOf(entry["replaced"]),
      added,
    });
  }
  return entries;
}
