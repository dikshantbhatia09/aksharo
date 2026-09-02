"use client";

/**
 * The style preview canvas: one StyleDoc, drawn live at whatever instant the
 * caller asks for, on the same renderer the editor and the export use.
 *
 * The picker uses it as an animated tile — `playing` loops the style's own
 * three-second preview — and the Colors, Look and Anim panels use it as a still
 * that updates as the user drags a slider. Either way the pixels come from
 * `render-core` plus CanvasKit, so what a creator picks is what they get.
 */

import { useEffect, useRef } from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import {
  animate,
  layoutSegment,
  PREVIEW_DURATION_MS,
  previewFor,
  previewStillMs,
} from "@montaj/render-core";
import type { WordScript } from "@montaj/render-core";

import { useRenderer } from "./use-canvaskit";

import { cn } from "@/lib/utils";

export interface StylePreviewCanvasProps {
  readonly style: StyleDoc;
  /** Tile size in device-independent pixels. Defaults to a 9:16 quarter-tile. */
  readonly width?: number;
  readonly height?: number;
  /** Loop the style's three-second preview; a still is drawn otherwise. */
  readonly playing?: boolean;
  /** Freeze the preview at this instant instead of at the default still. */
  readonly tMs?: number;
  /** Preview text script; an Indic style is previewed in its own script. */
  readonly script?: WordScript;
  readonly background?: string;
  readonly className?: string;
  readonly label?: string;
}

export function StylePreviewCanvas({
  style,
  width = 270,
  height = 480,
  playing = false,
  tMs,
  script = "latin",
  background = "#242430ff",
  className,
  label,
}: StylePreviewCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { backend, engine, error, loading } = useRenderer();

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null || backend === undefined || engine === undefined) return;

    element.width = width;
    element.height = height;
    // A tile is small and there may be thirty of them: the CPU surface costs
    // less than thirty WebGL contexts, which browsers cap anyway.
    const surface = backend.ck.MakeSWCanvasSurface(element);
    if (surface === null) return;

    const preview = previewFor(style.id, script);
    let frame = 0;
    let start = 0;

    const draw = (now: number): void => {
      if (start === 0) start = now;
      const at = tMs ?? (playing ? (now - start) % PREVIEW_DURATION_MS : previewStillMs());
      const layout = layoutSegment({
        style,
        segment: preview.segment,
        words: preview.words,
        canvas: { width, height },
        registry: engine.registry,
        shaper: engine.shaper,
        tMs: at,
      });
      backend.drawFrame(surface.getCanvas(), animate({ layout, style, tMs: at }), { background });
      surface.flush();
      if (playing && tMs === undefined) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return (): void => {
      cancelAnimationFrame(frame);
      surface.delete();
    };
  }, [backend, engine, style, width, height, playing, tMs, script, background]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("block rounded-md", className)}
      style={{ width, height }}
      role="img"
      aria-label={label ?? `${style.name} caption style preview`}
      data-testid={`style-preview-${style.id}`}
      data-state={error !== undefined ? "error" : loading ? "loading" : "ready"}
    />
  );
}
