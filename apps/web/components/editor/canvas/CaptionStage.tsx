"use client";

/**
 * The editor's canvas row: the proxy `<video>` with the caption overlay drawn on
 * top of it by CanvasKit, at proxy resolution, inside an aspect frame with the
 * safe zones drawn.
 *
 * Two things make it trustworthy rather than merely pretty:
 *
 * - **The overlay is the export.** Every frame comes from `renderFrame`, the
 *   same function the cloud renderer calls, so what is on screen is what is
 *   burned in.
 * - **Frame-accurate scrub.** `requestVideoFrameCallback` gives the presented
 *   frame's media time, so the caption drawn is the caption for the frame the
 *   viewer is actually looking at — a `timeupdate` listener would be up to
 *   250 ms out and the karaoke fill would visibly lag.
 *
 * Dragging the caption box emits exactly one `SetSegmentPosition` per drop
 * (CONTRACTS §2), never one per pointer move.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import { layoutFrame, renderFrame } from "@montaj/render-core";
import type { EdgProjection } from "@montaj/render-core";

import {
  type Anchor,
  type Box,
  boxContains,
  boxToCss,
  fitStage,
  positionFromDrag,
  safeZonesFor,
  type SegmentPosition,
  type StageFit,
  toProjectPoint,
} from "./stage-geometry";
import { useRenderer } from "./use-canvaskit";
import { setSegmentPosition, type SetSegmentPositionOp } from "../panels/ops";

import { cn } from "@/lib/utils";

/**
 * `requestVideoFrameCallback` is declared in the DOM lib but is not implemented
 * everywhere (WebKit before 17 has none), so it is looked up at runtime rather
 * than trusted from the type.
 */
type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

interface MaybeFrameCallbackVideo {
  requestVideoFrameCallback?: (callback: FrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface CaptionStageProps {
  /** Proxy URL from R2 (`proxy540.mp4`, CONTRACTS §6). */
  readonly src: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  /** The surface the overlay is drawn at; the proxy's own size by default. */
  readonly canvas?: { readonly width: number; readonly height: number };
  /** Emitted once per drop when the caption box is dragged. */
  readonly onOp?: (op: SetSegmentPositionOp) => void;
  /** The segment the user is editing; only that one can be dragged. */
  readonly selectedSegmentId?: string;
  readonly showSafeZones?: boolean;
  readonly className?: string;
  /** Extra layers (B20's proposal overlays) drawn above the caption overlay. */
  readonly children?: React.ReactNode;
}

interface DragState {
  readonly pointerId: number;
  readonly origin: { x: number; y: number };
  readonly box: Box;
  readonly anchor: Anchor;
  readonly safeAreaPct: number;
}

export function CaptionStage({
  src,
  projection,
  catalogue,
  canvas,
  onOp,
  selectedSegmentId,
  showSafeZones = true,
  className,
  children,
}: CaptionStageProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | undefined>(undefined);

  const { backend, engine, error, loading } = useRenderer();
  const surfaceCanvas = canvas ?? projection.canvas;
  const [fit, setFit] = useState<StageFit>({ width: 0, height: 0, left: 0, top: 0, scale: 0 });
  const [outputMs, setOutputMs] = useState(0);
  const [dragPreview, setDragPreview] = useState<SegmentPosition | undefined>(undefined);
  const [captionBox, setCaptionBox] = useState<Box | undefined>(undefined);

  // Fit the stage to whatever box the editor gives it.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = (): void => {
      setFit(fitStage({ width: element.clientWidth, height: element.clientHeight }, surfaceCanvas));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [surfaceCanvas]);

  // Frame-accurate clock: the media time of the frame actually presented.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let handle = 0;
    let cancelled = false;

    const maybe = video as unknown as MaybeFrameCallbackVideo;
    const request = maybe.requestVideoFrameCallback?.bind(video);
    const cancel = maybe.cancelVideoFrameCallback?.bind(video);
    if (request !== undefined) {
      const step: FrameCallback = (_now, metadata) => {
        if (cancelled) return;
        setOutputMs(Math.round(metadata.mediaTime * 1000));
        handle = request(step);
      };
      handle = request(step);
      return (): void => {
        cancelled = true;
        cancel?.(handle);
      };
    }

    // WebKit before 17 has no frame callback; rAF is the honest fallback and is
    // still far tighter than `timeupdate`.
    const tick = (): void => {
      if (cancelled) return;
      setOutputMs(Math.round(video.currentTime * 1000));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return (): void => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  // Draw the overlay for the current output instant.
  useEffect(() => {
    const element = overlayRef.current;
    if (element === null || backend === undefined || engine === undefined) return;
    element.width = surfaceCanvas.width;
    element.height = surfaceCanvas.height;
    const surface =
      backend.ck.MakeWebGLCanvasSurface(element) ?? backend.ck.MakeSWCanvasSurface(element);
    if (surface === null) return;

    const options = {
      projection: withDragPreview(projection, selectedSegmentId, dragPreview),
      timemap: null,
      catalogue,
      registry: engine.registry,
      shaper: engine.shaper,
      canvas: surfaceCanvas,
      outputMs,
    } as const;

    backend.drawFrame(surface.getCanvas(), renderFrame(options), { background: "#00000000" });
    surface.flush();

    // The caption box the drag handle sits on, in project pixels.
    const laid = layoutFrame(options);
    const selected =
      selectedSegmentId === undefined
        ? laid[0]
        : laid.find((entry) => entry.layout.segmentId === selectedSegmentId);
    setCaptionBox(selected === undefined ? undefined : (selected.layout.paddedBox as Box));

    return (): void => {
      surface.delete();
    };
  }, [
    backend,
    engine,
    projection,
    catalogue,
    surfaceCanvas,
    outputMs,
    selectedSegmentId,
    dragPreview,
  ]);

  const styleOf = useCallback(
    (segmentId: string): StyleDoc | undefined => {
      const segment = projection.segments.find((entry) => entry.id === segmentId);
      return catalogue.get(segment?.styleRef ?? projection.styles.defaultStyleId);
    },
    [catalogue, projection],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = containerRef.current;
      if (container === null || captionBox === undefined || selectedSegmentId === undefined) return;
      const rect = container.getBoundingClientRect();
      const point = toProjectPoint(
        { x: event.clientX, y: event.clientY },
        { x: rect.left, y: rect.top },
        fit,
      );
      if (!boxContains(captionBox, point)) return;

      const style = styleOf(selectedSegmentId);
      dragRef.current = {
        pointerId: event.pointerId,
        origin: point,
        box: captionBox,
        anchor: (style?.layout.anchor ?? "bottom-center") as Anchor,
        safeAreaPct: style?.layout.safeAreaPct ?? 0,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [captionBox, fit, selectedSegmentId, styleOf],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      const container = containerRef.current;
      if (drag === undefined || container === null || drag.pointerId !== event.pointerId) return;
      const rect = container.getBoundingClientRect();
      const point = toProjectPoint(
        { x: event.clientX, y: event.clientY },
        { x: rect.left, y: rect.top },
        fit,
      );
      setDragPreview(
        positionFromDrag(
          { x: point.x - drag.origin.x, y: point.y - drag.origin.y },
          {
            box: drag.box,
            canvas: surfaceCanvas,
            anchor: drag.anchor,
            safeAreaPct: drag.safeAreaPct,
          },
        ),
      );
    },
    [fit, surfaceCanvas],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current;
      if (drag === undefined || drag.pointerId !== event.pointerId) return;
      dragRef.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
      // One op per drop, never one per move: the op queue is not a mouse log.
      if (dragPreview !== undefined && selectedSegmentId !== undefined) {
        onOp?.(setSegmentPosition(selectedSegmentId, dragPreview));
      }
      setDragPreview(undefined);
    },
    [dragPreview, onOp, selectedSegmentId],
  );

  const safeAreaPct =
    selectedSegmentId === undefined ? 0 : (styleOf(selectedSegmentId)?.layout.safeAreaPct ?? 0);
  const zones = safeZonesFor(surfaceCanvas, safeAreaPct);
  const handle = captionBox === undefined ? undefined : boxToCss(captionBox, fit);

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full touch-none select-none bg-black", className)}
      data-testid="caption-stage"
      data-state={error !== undefined ? "error" : loading ? "loading" : "ready"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="auto"
        className="absolute"
        style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }}
        data-testid="caption-stage-video"
      />
      <canvas
        ref={overlayRef}
        className="pointer-events-none absolute"
        style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }}
        data-testid="caption-stage-overlay"
      />
      {showSafeZones && safeAreaPct > 0 ? (
        <div
          className="pointer-events-none absolute border border-dashed border-white/25"
          style={{
            left: fit.left + zones.safe[0] * fit.scale,
            top: fit.top + zones.safe[1] * fit.scale,
            width: (zones.safe[2] - zones.safe[0]) * fit.scale,
            height: (zones.safe[3] - zones.safe[1]) * fit.scale,
          }}
          data-testid="caption-stage-safe-area"
        />
      ) : null}
      {handle !== undefined && selectedSegmentId !== undefined ? (
        <div
          className="pointer-events-none absolute rounded-sm border border-sky-400/80 bg-sky-400/5"
          style={handle}
          data-testid="caption-stage-box"
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * The projection the overlay draws while a drag is in flight: the dragged
 * segment gets the provisional position so the caption follows the pointer,
 * and nothing is committed until the drop.
 */
function withDragPreview(
  projection: EdgProjection,
  segmentId: string | undefined,
  position: SegmentPosition | undefined,
): EdgProjection {
  if (segmentId === undefined || position === undefined) return projection;
  return {
    ...projection,
    segments: projection.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, position } : segment,
    ),
  };
}
