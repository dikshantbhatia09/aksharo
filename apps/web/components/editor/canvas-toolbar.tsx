"use client";

/**
 * Multi-Aspect Ratio Toggle & Simultaneous Batch Export Toolbar (Pillar 3 §06 §5 Step 3).
 *
 * Provides:
 * 1. Segmented aspect ratio switcher `[9:16 | 1:1 | 4:5 | 16:9]` that immediately
 *    resizes the preview canvas wrapper, re-centers the crop window on normalized
 *    face coordinates `(centerX, centerY)`, and scales caption typography
 *    (`54px` for 9:16, `42px` for 1:1, `48px` for 4:5, `44px` for 16:9) and safe-zone `yOffset`.
 * 2. Simultaneous Multi-Format Batch Export checkboxes (`[x] 9:16  [x] 1:1  [x] 4:5  [x] 16:9`)
 *    and download cards for omnichannel social delivery (Reels, LinkedIn, Instagram 4:5, YouTube).
 */

import {
  computeAspectTypographyScaling,
  type AspectTypographyScaling,
} from "@montaj/caption-styles/browser";
import {
  MULTI_ASPECT_PRESETS,
  MULTI_ASPECT_RATIOS,
  MULTI_ASPECT_RESOLUTIONS,
  computeMultiAspectCrop,
  resolveMultiAspectDimensions,
  type MultiAspectExportPayload,
  type MultiAspectRatio,
  type MultiAspectResolution,
  type MultiAspectVariantOutput,
} from "@montaj/repurpose-contracts";
import React, { useCallback, useMemo, useState } from "react";

export interface CanvasAspectPreviewState {
  readonly aspect: MultiAspectRatio;
  readonly resolution: MultiAspectResolution;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly typography: AspectTypographyScaling;
  readonly platformSummary: string;
  readonly previewBox: {
    readonly widthPx: number;
    readonly heightPx: number;
  };
}

export function computeCanvasAspectPreviewState(options: {
  readonly aspect: MultiAspectRatio;
  readonly resolution?: MultiAspectResolution;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly centerX?: number;
  readonly centerY?: number;
  readonly maxPreviewDimensionPx?: number;
}): CanvasAspectPreviewState {
  const aspect = options.aspect;
  const resolution: MultiAspectResolution = options.resolution ?? "1080p";
  const sourceWidth = options.sourceWidth ?? 1920;
  const sourceHeight = options.sourceHeight ?? 1080;
  const centerX = options.centerX ?? 0.5;
  const centerY = options.centerY ?? 0.5;
  const maxPreview = options.maxPreviewDimensionPx ?? 240;

  const canvas = resolveMultiAspectDimensions(aspect, resolution);
  const crop = computeMultiAspectCrop(sourceWidth, sourceHeight, aspect, centerX, centerY);
  const typography = computeAspectTypographyScaling({
    aspect,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const preset = MULTI_ASPECT_PRESETS[aspect];

  const ratio = canvas.width / canvas.height;
  const previewBox =
    ratio >= 1
      ? {
          widthPx: maxPreview,
          heightPx: Math.max(48, Math.round(maxPreview / ratio)),
        }
      : {
          widthPx: Math.max(48, Math.round(maxPreview * ratio)),
          heightPx: maxPreview,
        };

  return {
    aspect,
    resolution,
    canvas,
    crop,
    typography,
    platformSummary: preset.platformSummary,
    previewBox,
  };
}

export function buildMultiAspectExportVariants(
  clipId: string,
  aspects: readonly MultiAspectRatio[],
  options: {
    readonly resolution?: MultiAspectResolution;
    readonly sourceWidth?: number;
    readonly sourceHeight?: number;
    readonly centerX?: number;
    readonly centerY?: number;
    readonly projectId?: string;
  } = {},
): readonly MultiAspectVariantOutput[] {
  const resolution: MultiAspectResolution = options.resolution ?? "1080p";
  const sourceWidth = options.sourceWidth ?? 1920;
  const sourceHeight = options.sourceHeight ?? 1080;
  const centerX = options.centerX ?? 0.5;
  const centerY = options.centerY ?? 0.5;

  return aspects.map((aspect) => {
    const state = computeCanvasAspectPreviewState({
      aspect,
      resolution,
      sourceWidth,
      sourceHeight,
      centerX,
      centerY,
    });
    // eslint-disable-next-line security/detect-object-injection -- closed enum key
    const preset = MULTI_ASPECT_PRESETS[aspect];
    const filename = `clip_${preset.filenameSlug}.mp4`;
    const downloadUrl = `/api/v1/projects/${encodeURIComponent(options.projectId ?? "default")}/clips/${encodeURIComponent(clipId)}/downloads/${encodeURIComponent(filename)}`;
    return {
      aspect,
      resolution,
      width: state.canvas.width,
      height: state.canvas.height,
      crop: state.crop,
      captionFontSizePx: state.typography.fontSizePx,
      captionYOffsetPx: state.typography.yOffset,
      filename,
      status: "ready",
      downloadUrl,
    };
  });
}

export interface CanvasToolbarProps {
  /** Clip identifier used for multi-aspect export payloads. */
  readonly clipId?: string;
  /** Project identifier used for multi-aspect export requests. */
  readonly projectId?: string;
  /** Initial active preview aspect ratio (defaults to `"9:16"`). */
  readonly initialAspect?: MultiAspectRatio;
  /** Initial resolution tier (defaults to `"1080p"`). */
  readonly initialResolution?: MultiAspectResolution;
  /** Initial selected aspects for Simultaneous Multi-Format Batch Export. */
  readonly initialSelectedAspects?: readonly MultiAspectRatio[];
  /** Probed source video width in pixels (defaults to 1920). */
  readonly sourceWidth?: number;
  /** Probed source video height in pixels (defaults to 1080). */
  readonly sourceHeight?: number;
  /** Normalized subject horizontal center `0.0..1.0` from face tracking. */
  readonly centerX?: number;
  /** Normalized subject vertical center `0.0..1.0` from face tracking. */
  readonly centerY?: number;
  /** Callback fired immediately when the editor switches the preview aspect ratio. */
  readonly onAspectChange?: (
    aspect: MultiAspectRatio,
    state: CanvasAspectPreviewState,
  ) => void;
  /** Callback fired when Simultaneous Multi-Format Batch Export is triggered. */
  readonly onBatchExport?: (
    payload: MultiAspectExportPayload,
    variants: readonly MultiAspectVariantOutput[],
  ) => void;
  /** Disable interactive controls while a cut or render is in flight. */
  readonly busy?: boolean;
}

function aspectSlug(aspect: MultiAspectRatio): string {
  return aspect.replace(":", "x");
}

export function CanvasToolbar({
  clipId = "clip_default",
  projectId = "project_default",
  initialAspect = "9:16",
  initialResolution = "1080p",
  initialSelectedAspects = ["9:16", "1:1"],
  sourceWidth = 1920,
  sourceHeight = 1080,
  centerX = 0.5,
  centerY = 0.5,
  onAspectChange,
  onBatchExport,
  busy = false,
}: CanvasToolbarProps): React.JSX.Element {
  const [activeAspect, setActiveAspect] = useState<MultiAspectRatio>(initialAspect);
  const [resolution, setResolution] = useState<MultiAspectResolution>(initialResolution);
  const [selectedAspects, setSelectedAspects] = useState<readonly MultiAspectRatio[]>(
    initialSelectedAspects.length > 0 ? initialSelectedAspects : ["9:16"],
  );
  const [exportedVariants, setExportedVariants] = useState<
    readonly MultiAspectVariantOutput[]
  >([]);

  const preview = useMemo(
    () =>
      computeCanvasAspectPreviewState({
        aspect: activeAspect,
        resolution,
        sourceWidth,
        sourceHeight,
        centerX,
        centerY,
      }),
    [activeAspect, resolution, sourceWidth, sourceHeight, centerX, centerY],
  );

  const handleSelectAspect = useCallback(
    (nextAspect: MultiAspectRatio) => {
      setActiveAspect(nextAspect);
      const nextState = computeCanvasAspectPreviewState({
        aspect: nextAspect,
        resolution,
        sourceWidth,
        sourceHeight,
        centerX,
        centerY,
      });
      onAspectChange?.(nextAspect, nextState);
    },
    [resolution, sourceWidth, sourceHeight, centerX, centerY, onAspectChange],
  );

  const handleToggleBatchAspect = useCallback((aspect: MultiAspectRatio) => {
    setSelectedAspects((prev) => {
      if (prev.includes(aspect)) {
        // Keep at least one aspect selected for batch export
        return prev.length > 1 ? prev.filter((item) => item !== aspect) : prev;
      }
      return MULTI_ASPECT_RATIOS.filter((candidate) => prev.includes(candidate) || candidate === aspect);
    });
  }, []);

  const handleBatchExport = useCallback(() => {
    const payload: MultiAspectExportPayload = {
      clipId,
      targets: selectedAspects.map((aspect) => ({
        aspect,
        resolution,
      })),
    };
    const variants = buildMultiAspectExportVariants(clipId, selectedAspects, {
      resolution,
      sourceWidth,
      sourceHeight,
      centerX,
      centerY,
      projectId,
    });
    setExportedVariants(variants);
    onBatchExport?.(payload, variants);
  }, [
    clipId,
    selectedAspects,
    resolution,
    sourceWidth,
    sourceHeight,
    centerX,
    centerY,
    projectId,
    onBatchExport,
  ]);

  return (
    <div
      className="flex flex-col gap-3 rounded-sm border border-border bg-surface p-3"
      data-testid="canvas-toolbar"
    >
      {/* Top row: Segmented Aspect Ratio Switcher [9:16 | 1:1 | 4:5 | 16:9] */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg-1">Canvas Aspect</span>
          <div
            role="group"
            aria-label="Aspect ratio switcher"
            className="inline-flex rounded-full border border-border bg-sunken p-0.5"
            data-testid="aspect-ratio-segmented-control"
          >
            {MULTI_ASPECT_RATIOS.map((aspect) => {
              const isSelected = activeAspect === aspect;
              const slug = aspectSlug(aspect);
              return (
                <button
                  key={aspect}
                  type="button"
                  aria-pressed={isSelected}
                  disabled={busy}
                  onClick={() => {
                    handleSelectAspect(aspect);
                  }}
                  className={`inline-flex min-h-7 items-center rounded-full px-2.5 font-mono text-xs transition-colors ${
                    isSelected
                      ? "bg-bg-2 font-semibold text-fg-0 shadow-sm"
                      : "font-medium text-fg-2 hover:text-fg-0"
                  }`}
                  data-testid={`aspect-toggle-${slug}`}
                >
                  {aspect}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-fg-2">Resolution</span>
          <div
            role="group"
            aria-label="Export resolution"
            className="inline-flex rounded-full border border-border bg-sunken p-0.5"
          >
            {MULTI_ASPECT_RESOLUTIONS.map((res) => (
              <button
                key={res}
                type="button"
                aria-pressed={resolution === res}
                disabled={busy}
                onClick={() => {
                  setResolution(res);
                }}
                className={`inline-flex min-h-6 items-center rounded-full px-2 font-mono text-2xs ${
                  resolution === res
                    ? "bg-bg-2 font-semibold text-fg-0"
                    : "text-fg-2 hover:text-fg-0"
                }`}
                data-testid={`resolution-toggle-${res}`}
              >
                {res}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live Preview Canvas Wrapper & Re-calculated Crop + Adaptive Typography Telemetry */}
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[auto_1fr]">
        <div className="flex items-center justify-center rounded-sm border border-border bg-ink p-2">
          <div
            style={{
              width: `${String(preview.previewBox.widthPx)}px`,
              height: `${String(preview.previewBox.heightPx)}px`,
            }}
            className="relative flex flex-col items-center justify-between overflow-hidden rounded-xs border border-border/80 bg-sunken p-2 transition-all duration-150"
            data-testid="canvas-preview-wrapper"
            data-aspect={preview.aspect}
            data-width={String(preview.canvas.width)}
            data-height={String(preview.canvas.height)}
          >
            <span className="font-mono text-2xs text-fg-2">
              {preview.canvas.width}×{preview.canvas.height} ({preview.aspect})
            </span>
            <span className="rounded-full bg-surface/80 px-2 py-0.5 font-mono text-2xs text-fg-1">
              Face ({Math.round(centerX * 100)}%, {Math.round(centerY * 100)}%)
            </span>
            <div
              className="w-full rounded-xs border border-border/60 bg-ink/80 px-1.5 py-1 text-center font-mono text-2xs text-fg-0"
              data-testid="canvas-caption-preview"
              data-font-size-px={String(preview.typography.fontSizePx)}
              data-y-offset-px={String(preview.typography.yOffset)}
            >
              Caption {preview.typography.fontSizePx}px · yOffset {preview.typography.yOffset}px
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 text-xs">
          <p className="m-0 font-medium text-fg-0" data-testid="canvas-platform-summary">
            {preview.platformSummary}
          </p>
          <p
            className="m-0 font-mono text-2xs text-fg-2"
            data-testid="canvas-crop-bounds"
          >
            Source crop: {preview.crop.width}×{preview.crop.height} at ({preview.crop.x},{" "}
            {preview.crop.y})
          </p>
          <p
            className="m-0 font-mono text-2xs text-fg-2"
            data-testid="canvas-typography-metrics"
          >
            Typography: {preview.typography.fontSizePx}px ({preview.typography.sizePct}% H) ·
            Line height {preview.typography.lineHeight} · Safe bottom {preview.typography.safeBottomPx}px
          </p>
        </div>
      </div>

      {/* Simultaneous Multi-Format Batch Export Bar */}
      <div className="flex flex-col gap-2 border-t border-border pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Multi-format batch export selection"
            className="flex flex-wrap items-center gap-3"
          >
            <span className="text-xs font-medium text-fg-1">Batch Export:</span>
            {MULTI_ASPECT_RATIOS.map((aspect) => {
              const checked = selectedAspects.includes(aspect);
              const slug = aspectSlug(aspect);
              return (
                <label
                  key={aspect}
                  className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-xs text-fg-0"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() => {
                      handleToggleBatchAspect(aspect);
                    }}
                    data-testid={`batch-aspect-checkbox-${slug}`}
                  />
                  <span>{aspect}</span>
                </label>
              );
            })}
          </div>

          <button
            type="button"
            disabled={busy || selectedAspects.length === 0}
            onClick={handleBatchExport}
            className="inline-flex min-h-8 items-center rounded-sm border border-border bg-bg-2 px-3 text-xs font-semibold text-fg-0 transition-colors hover:bg-surface disabled:opacity-60"
            data-testid="batch-export-button"
          >
            Export {selectedAspects.length}{" "}
            {selectedAspects.length === 1 ? "Format" : "Formats"}
          </button>
        </div>

        {exportedVariants.length > 0 ? (
          <ul
            className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2"
            data-testid="batch-export-download-cards"
          >
            {exportedVariants.map((variant) => {
              const slug = aspectSlug(variant.aspect);
              return (
                <li
                  key={`${variant.aspect}-${variant.resolution}`}
                  className="flex items-center justify-between gap-2 rounded-xs border border-border bg-sunken px-2.5 py-2 text-xs"
                  data-testid={`batch-download-card-${slug}`}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold text-fg-0">
                      {variant.aspect} ({variant.width}×{variant.height})
                    </span>
                    <span className="font-mono text-2xs text-fg-2">
                      {variant.filename} · {variant.captionFontSizePx}px captions
                    </span>
                  </div>
                  <a
                    href={variant.downloadUrl}
                    download={variant.filename}
                    className="font-medium text-fg-0 underline"
                    data-testid={`batch-download-link-${slug}`}
                  >
                    Download
                  </a>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
