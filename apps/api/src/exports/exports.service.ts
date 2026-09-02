import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { formatCredits, quote } from "@montaj/config";
import type {
  OutputKind,
  RenderPreset,
  SubtitleScript,
  WatermarkPosition,
} from "@montaj/render-manifest";
import { fromAcceptedItems } from "@montaj/timemap";

import { BrandAssetsService } from "./brand-assets.service.js";
import { BrowserManifestDailyCap } from "./daily-cap.js";
import { decideExport, type ExportDecisionInput, type SubtitleFormat } from "./decision.js";
import { DefaultWatermarkService } from "./default-watermark.service.js";
import { EXPORT_RETENTION_DAYS } from "./exports.constants.js";
import { EXPORT_ERROR_CODES } from "./exports.errors.js";
import { buildRenderManifest, RENDER_CORE_VERSION } from "./manifest-builder.js";
import { NINE_PASS_LEDGER, type NinePassLedger } from "./nine-pass-ledger.js";
import { buildRenderProjection, resolveStyleSnapshot } from "./projection.js";
import { ManifestSignerService } from "../common/crypto/manifest-signer.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import {
  DERIVED_STORE,
  DOWNLOAD_URL_TTL_SECONDS,
  type ObjectStore,
} from "../common/storage/index.js";
import { EdgRepository } from "../edg/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Export, ExportManifest } from "@prisma/client";

export interface RequestExportInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly kind: "video" | "subtitle";
  readonly outputKind: OutputKind;
  readonly preset: RenderPreset;
  readonly customWidth?: number;
  readonly customHeight?: number;
  readonly script: SubtitleScript;
  readonly mode: "auto" | "browser" | "cloud";
  readonly dropFillers: boolean;
  readonly subtitle?: {
    readonly formats: readonly SubtitleFormat[];
    readonly scripts: readonly SubtitleScript[];
  };
  readonly capabilities?: ExportDecisionInput["capabilities"];
  readonly options: {
    readonly brandAssetId?: string;
    readonly watermarkPosition: WatermarkPosition;
    readonly watermarkOpacity: number;
  };
}

export interface RequestExportResult {
  readonly exportId: string;
  readonly path: "browser" | "cloud";
  readonly reasons: readonly string[];
  readonly watermarked: boolean;
  readonly quote: { readonly tenths: number; readonly credits: string };
  readonly manifest?: Record<string, unknown>;
  readonly job?: {
    readonly jobId: string;
    readonly status: string;
    readonly deduplicated: boolean;
  };
}

export interface CompleteManifestInput {
  readonly manifestId: string;
  readonly workspaceId: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly checksum: string;
}

export interface ListExportsInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const RENDER_VIDEO_QUEUE: QueueName = "render.video";
const RENDER_SUBTITLE_QUEUE: QueueName = "render.subtitle";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * The exports surface: the decision engine's caller, the manifest issuer, the
 * cloud job producer, the browser completion path, downloads and retention.
 *
 * Every write here is either a signed manifest (never authored by a client) or a
 * row this service alone creates — the completion handlers in
 * `render-completion.handler.ts` are the only other writer, and only for the
 * cloud path.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly edgRepository: EdgRepository,
    private readonly entitlements: EntitlementService,
    private readonly jobs: JobsService,
    private readonly signer: ManifestSignerService,
    private readonly brandAssets: BrandAssetsService,
    private readonly dailyCap: BrowserManifestDailyCap,
    private readonly defaultWatermark: DefaultWatermarkService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
    @Inject(NINE_PASS_LEDGER) private readonly ninePass: NinePassLedger,
  ) {}

  // -------------------------------------------------------------------------
  // POST /projects/{id}/exports
  // -------------------------------------------------------------------------

  async requestExport(input: RequestExportInput): Promise<RequestExportResult> {
    const { project, media, edg } = await this.resolveRenderContext(
      input.projectId,
      input.workspaceId,
    );

    const entitlement = await this.entitlements.forWorkspace(input.workspaceId);
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { signupGiftConsumedAt: true },
    });

    const allItems = edg.passes.flatMap((pass) => pass.items);
    const timeMap = fromAcceptedItems(allItems, { sourceDurationMs: media.durationMs ?? 0 });
    const outputDurationMs = timeMap.outputDurationMs;

    const signupGiftEntitled =
      entitlement.entitlements["signupGift"] !== null &&
      entitlement.entitlements["signupGift"] !== undefined;
    const signupGiftAvailable = signupGiftEntitled && workspace.signupGiftConsumedAt === null;
    const ninePassAvailable = await this.ninePass.isAvailable(input.workspaceId);

    // Resolved before `decideExport` (rather than after, as before A18a) so an
    // `ass` subtitle request can be judged against the real, gated flags: an
    // `ass` request is allowed only when every StyleDoc the project's captions
    // actually reference carries `assRenderable: true`, the flag only
    // `@montaj/ass-exporter`'s parity gate writes (D33).
    const styleSnapshot = await resolveStyleSnapshot(this.prisma, input.workspaceId, edg);
    const assStylesRenderable = Object.values(styleSnapshot.styles).every(
      (doc) => (doc as { assRenderable?: unknown } | null)?.assRenderable === true,
    );

    const decisionInput: ExportDecisionInput = {
      requestedMode: input.mode,
      kind: input.kind,
      outputKind: input.outputKind,
      preset: input.preset,
      ...(input.customWidth === undefined ? {} : { customWidth: input.customWidth }),
      ...(input.customHeight === undefined ? {} : { customHeight: input.customHeight }),
      ...(input.subtitle === undefined
        ? {}
        : { subtitleFormats: input.subtitle.formats, assStylesRenderable }),
      sourceDurationMs: media.durationMs ?? 0,
      outputDurationMs,
      plan: entitlement.planKey,
      entitlements: entitlement.entitlements,
      signupGiftAvailable,
      ninePassAvailable,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    };
    const decision = decideExport(decisionInput);
    if (decision.watermark) await this.defaultWatermark.ensure(input.workspaceId);

    const exportId = ulid();
    const projection = buildRenderProjection(
      edg,
      await this.edgRepository.loadChunks(edg.transcript.transcriptId),
    );

    const brandWatermark =
      decision.watermark || input.options.brandAssetId === undefined
        ? undefined
        : await this.brandAssets.resolveForWatermark(
            input.workspaceId,
            input.options.brandAssetId,
            input.options.watermarkPosition,
            input.options.watermarkOpacity,
          );

    const { manifest: unsigned } = buildRenderManifest({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      exportId,
      edg: {
        edgId: edg.meta.edgId,
        revision: edg.meta.revision,
        ...(edg.transcript.transcriptId === undefined
          ? {}
          : { transcriptId: edg.transcript.transcriptId }),
      },
      styleSnapshot,
      source: {
        mediaId: media.id,
        bucket: media.bucket === "s3" ? "raw" : "derived",
        key: media.storageKey,
        durationMs: media.durationMs ?? 0,
        ...(media.width === null || media.width === undefined ? {} : { width: media.width }),
        ...(media.height === null || media.height === undefined ? {} : { height: media.height }),
        ...(media.fps === null || media.fps === undefined ? {} : { fps: media.fps }),
      },
      timemapEdits: [...timeMap.edits],
      outputDurationMs,
      decision,
      kind: input.kind,
      outputKind: input.outputKind,
      preset: input.preset,
      ...(input.customWidth === undefined ? {} : { customWidth: input.customWidth }),
      ...(input.customHeight === undefined ? {} : { customHeight: input.customHeight }),
      projectAspect: project.aspect,
      ...(input.subtitle === undefined
        ? {}
        : { subtitleFormats: input.subtitle.formats, subtitleScripts: input.subtitle.scripts }),
      dropFillers: input.dropFillers,
      ...(brandWatermark === undefined ? {} : { brandWatermark }),
    });
    const manifest = this.signer.sign(unsigned);

    if (decision.path === "browser") {
      const cap = await this.dailyCap.recordAndCheck(input.workspaceId);
      if (cap.overCap) {
        throw new AppException(
          EXPORT_ERROR_CODES.dailyManifestCapExceeded,
          "Too many browser exports today — try again tomorrow, or use a cloud render.",
          HttpStatus.TOO_MANY_REQUESTS,
          { count: cap.count },
        );
      }

      await this.prisma.exportManifest.create({
        data: {
          id: manifest.manifestId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          nonce: manifest.nonce,
          mode: "browser",
          manifest: manifest as unknown as object,
          issuedAt: new Date(manifest.issuedAt),
          expiresAt: new Date(manifest.expiresAt),
          consumesSignupGift: decision.consumesSignupGift,
          consumesNinePass: decision.consumesNinePass,
        },
      });
      await this.prisma.export.create({
        data: {
          id: exportId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          manifestId: manifest.manifestId,
          status: "pending_browser",
          kind: manifest.output.container === "mov" ? "mov" : "mp4",
          preset: input.preset,
          bucket: "r2",
          watermarked: decision.watermark,
          resolution: `${String(manifest.output.width)}x${String(manifest.output.height)}`,
        },
      });

      return {
        exportId,
        path: "browser",
        reasons: decision.reasons,
        watermarked: decision.watermark,
        quote: { tenths: 0, credits: formatCredits(0) },
        manifest: manifest as unknown as Record<string, unknown>,
      };
    }

    // Cloud path: a video render or a subtitle job. The manifest row is still
    // written — for the audit trail and so the completion handler can look the
    // decision back up — but its nonce is consumed by the job, not by
    // `POST /exports/manifests/{id}/complete`.
    await this.prisma.exportManifest.create({
      data: {
        id: manifest.manifestId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        nonce: manifest.nonce,
        mode: "cloud",
        manifest: manifest as unknown as object,
        issuedAt: new Date(manifest.issuedAt),
        expiresAt: new Date(manifest.expiresAt),
        consumesSignupGift: false,
        consumesNinePass: false,
      },
    });

    const queue = input.kind === "subtitle" ? RENDER_SUBTITLE_QUEUE : RENDER_VIDEO_QUEUE;
    // B02b: routed through `quote()` rather than `creditCostTenths` directly,
    // so this reserve and `decision.ts`'s dialog estimate can never compute the
    // 0.1-minute billing quantum two different ways.
    const worstCaseTenths =
      input.kind === "subtitle"
        ? 0
        : quote("cloudRender", (media.durationMs ?? 0) / 60_000).holdTenths;

    const enqueued = await this.jobs.enqueue({
      type: queue,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      jobKey: `${queue}:${input.projectId}:${manifest.manifestId}`,
      worstCaseTenths,
      reason: `${queue} · export ${exportId}`,
      params: {
        manifest: manifest as unknown as Record<string, unknown>,
        projection,
        styles: styleSnapshot.styles,
        path: "skia",
        script: input.script,
        dropFillers: input.dropFillers,
      },
    });

    this.logger.log(
      {
        exportId,
        projectId: input.projectId,
        jobId: enqueued.job.id,
        queue,
        renderCoreVersion: RENDER_CORE_VERSION,
      },
      "cloud export job enqueued",
    );

    return {
      exportId,
      path: "cloud",
      reasons: decision.reasons,
      watermarked: decision.watermark,
      quote: { tenths: worstCaseTenths, credits: formatCredits(worstCaseTenths) },
      job: {
        jobId: enqueued.job.id,
        status: enqueued.job.status,
        deduplicated: enqueued.deduplicated,
      },
    };
  }

  // -------------------------------------------------------------------------
  // POST /exports/manifests/{id}/complete
  // -------------------------------------------------------------------------

  async completeManifest(
    input: CompleteManifestInput,
  ): Promise<{ exportId: string; downloadAvailable: boolean }> {
    const row = await this.prisma.exportManifest.findFirst({
      where: { id: input.manifestId, workspaceId: input.workspaceId },
    });
    if (row === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.manifestNotFound,
        "No such manifest.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.mode !== "browser") {
      throw new AppException(
        EXPORT_ERROR_CODES.manifestInvalid,
        "This manifest is not a browser-render manifest.",
        HttpStatus.CONFLICT,
      );
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new AppException(
        EXPORT_ERROR_CODES.manifestExpired,
        "This manifest has expired.",
        HttpStatus.GONE,
      );
    }

    const claimed = await this.prisma.exportManifest.updateMany({
      where: { id: input.manifestId, workspaceId: input.workspaceId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw new AppException(
        EXPORT_ERROR_CODES.manifestAlreadyConsumed,
        "This manifest has already been used.",
        HttpStatus.CONFLICT,
      );
    }

    const exportRow = await this.prisma.export.findFirst({
      where: { manifestId: input.manifestId },
    });
    if (exportRow === null) {
      // The manifest was created by this same call path, which always creates
      // the export row first — this branch is unreachable outside a bug.
      throw new AppException(
        EXPORT_ERROR_CODES.exportNotFound,
        "No export for this manifest.",
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.export.update({
      where: { id: exportRow.id },
      data: {
        status: "succeeded",
        sizeBytes: BigInt(input.sizeBytes),
        durationMs: input.durationMs,
        checksum: input.checksum,
        expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60_000),
      },
    });

    if (row.consumesSignupGift) {
      await this.prisma.workspace.updateMany({
        where: { id: input.workspaceId, signupGiftConsumedAt: null },
        data: { signupGiftConsumedAt: new Date() },
      });
    }
    if (row.consumesNinePass) {
      await this.ninePass.consume(input.workspaceId, input.manifestId);
    }

    await this.prisma.publishEvent.create({
      data: {
        id: ulid(),
        workspaceId: input.workspaceId,
        projectId: row.projectId,
        surface: "web",
        exportId: exportRow.id,
      },
    });

    return { exportId: exportRow.id, downloadAvailable: false };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(input: ListExportsInput): Promise<Page<Export>> {
    const take = clampLimit(input.limit);
    const items = await this.prisma.export.findMany({
      where: { projectId: input.projectId, workspaceId: input.workspaceId },
      orderBy: { id: "desc" },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: take + 1,
    });
    return page(items, take, (row) => row.id);
  }

  async downloadUrl(
    exportId: string,
    workspaceId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const row = await this.prisma.export.findFirst({ where: { id: exportId, workspaceId } });
    if (row === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.exportNotFound,
        "No such export.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.storageKey === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.exportNotReady,
        "This export has no downloadable file — a browser export never leaves the browser.",
        HttpStatus.CONFLICT,
      );
    }

    const url = await this.store.presignGet(row.storageKey, DOWNLOAD_URL_TTL_SECONDS);
    await this.prisma.export.update({
      where: { id: exportId },
      data: { downloads: { increment: 1 } },
    });

    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Retention (B16 wires the schedule; this is the method it calls)
  // -------------------------------------------------------------------------

  async purgeExpiredExports(now: Date = new Date()): Promise<{ purged: number }> {
    const due = await this.prisma.export.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, storageKey: true },
      take: 500,
    });
    if (due.length === 0) return { purged: 0 };

    const keys = due.map((row) => row.storageKey).filter((key): key is string => key !== null);
    if (keys.length > 0) {
      try {
        await this.store.deleteMany(keys);
      } catch (error) {
        this.logger.warn(
          { err: error, count: keys.length },
          "export purge could not delete every object",
        );
      }
    }

    await this.prisma.export.deleteMany({ where: { id: { in: due.map((row) => row.id) } } });
    return { purged: due.length };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveRenderContext(projectId: string, workspaceId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true, aspect: true, edgDocument: { select: { id: true } } },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    if (project.edgDocument === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.edgNotInitialised,
        "This project has no editing document yet.",
        HttpStatus.CONFLICT,
      );
    }

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary", status: "ready" },
      orderBy: { createdAt: "desc" },
    });
    if (media === null || media.durationMs === null) {
      throw new AppException(
        EXPORT_ERROR_CODES.mediaNotReady,
        "The project's media is not ready to export yet.",
        HttpStatus.CONFLICT,
      );
    }

    const edg = await this.edgRepository.projectionOf(project.edgDocument.id);
    return { project, media, edg };
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function page<T>(rows: T[], take: number, id: (row: T) => string): Page<T> {
  if (rows.length <= take) return { items: rows, nextCursor: null };
  const items = rows.slice(0, take);
  const last = items[items.length - 1];
  return { items, nextCursor: last === undefined ? null : id(last) };
}

export type { ExportManifest };
