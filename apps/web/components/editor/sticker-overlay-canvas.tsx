"use client";

import { RotateCcw, Trash2, Move, Maximize2 } from "lucide-react";
import * as React from "react";

import { Badge, Button, cn } from "@montaj/ui";

import type { StageFit } from "./canvas/stage-geometry";

export interface StickerTransform {
  readonly x: number; // Normalized center X in [0, 1]
  readonly y: number; // Normalized center Y in [0, 1]
  readonly scale: number; // Scale multiplier (e.g. 1.0)
  readonly rotation: number; // Rotation in degrees (e.g. 0)
}

export interface StickerOverlayCanvasProps {
  readonly sticker: {
    readonly id: string;
    readonly url: string;
    readonly title?: string;
    readonly isTransparent?: boolean;
  };
  readonly x?: number;
  readonly y?: number;
  readonly scale?: number;
  readonly rotation?: number;
  readonly opacity?: number;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly fit: StageFit;
  readonly isSelected?: boolean;
  readonly onChange?: (transform: StickerTransform) => void;
  readonly onDelete?: () => void;
  readonly onSelect?: () => void;
  readonly baseWidth?: number;
  readonly baseHeight?: number;
  readonly className?: string;
}

type DragMode = "move" | "resize" | "rotate" | null;

/**
 * Interactive Sticker & Meme Canvas Gizmo (Pillar 6 §04).
 * Provides a free-transform bounding box over the video preview canvas:
 * - Center drag for positioning (x, y normalized 0..1).
 * - 4 Corner handles for proportional scaling.
 * - Top stem knob for 360-degree rotation.
 * - Real-time transform readout and quick delete action.
 */
export function StickerOverlayCanvas({
  sticker,
  x = 0.5,
  y = 0.5,
  scale = 1.0,
  rotation = 0,
  opacity = 1.0,
  canvas,
  fit,
  isSelected = true,
  onChange,
  onDelete,
  onSelect,
  baseWidth = 320,
  baseHeight = 320,
  className,
}: StickerOverlayCanvasProps): React.JSX.Element | null {
  if (fit.scale === 0) return null;

  const [currentTransform, setCurrentTransform] = React.useState<StickerTransform>({
    x,
    y,
    scale,
    rotation,
  });

  // Sync with incoming props if changed externally
  React.useEffect(() => {
    setCurrentTransform({ x, y, scale, rotation });
  }, [x, y, scale, rotation]);

  const dragRef = React.useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    initialTransform: StickerTransform;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    initialTransform: currentTransform,
  });

  // Calculate box dimensions on the CSS canvas surface
  const boxWidth = baseWidth * currentTransform.scale * fit.scale;
  const boxHeight = baseHeight * currentTransform.scale * fit.scale;

  // Center position in CSS pixels relative to stage container
  const centerLeft = fit.left + currentTransform.x * canvas.width * fit.scale;
  const centerTop = fit.top + currentTransform.y * canvas.height * fit.scale;

  const handlePointerDown = (
    e: React.PointerEvent,
    mode: DragMode,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    if (onSelect) {
      onSelect();
    }

    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      initialTransform: { ...currentTransform },
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const { mode, startX, startY, initialTransform } = dragRef.current;
    if (!mode) return;

    e.stopPropagation();
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    if (mode === "move") {
      // Delta in project coordinates
      const projDeltaX = deltaX / (canvas.width * fit.scale);
      const projDeltaY = deltaY / (canvas.height * fit.scale);

      const newX = Math.max(0.05, Math.min(0.95, initialTransform.x + projDeltaX));
      const newY = Math.max(0.05, Math.min(0.95, initialTransform.y + projDeltaY));

      const updated = {
        ...initialTransform,
        x: Math.round(newX * 1000) / 1000,
        y: Math.round(newY * 1000) / 1000,
      };
      setCurrentTransform(updated);
      onChange?.(updated);
    } else if (mode === "resize") {
      // Diagonal distance delta for proportional resize
      const distanceDelta = (deltaX + deltaY) / (150 * fit.scale);
      const newScale = Math.max(0.2, Math.min(4.0, initialTransform.scale + distanceDelta));

      const updated = {
        ...initialTransform,
        scale: Math.round(newScale * 100) / 100,
      };
      setCurrentTransform(updated);
      onChange?.(updated);
    } else if (mode === "rotate") {
      // Calculate angle between center and pointer
      const radians = Math.atan2(e.clientY - centerTop, e.clientX - centerLeft);
      // Offset by 90 degrees since rotation handle is at the top
      let degrees = Math.round((radians * 180) / Math.PI) + 90;
      if (degrees > 180) degrees -= 360;
      if (degrees < -180) degrees += 360;

      const updated = {
        ...initialTransform,
        rotation: degrees,
      };
      setCurrentTransform(updated);
      onChange?.(updated);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current.mode) {
      dragRef.current.mode = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture release safety
      }
    }
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    const reset = { ...currentTransform, scale: 1.0, rotation: 0 };
    setCurrentTransform(reset);
    onChange?.(reset);
  };

  const isVideoFormat =
    sticker.url.toLowerCase().endsWith(".webm") ||
    sticker.url.toLowerCase().endsWith(".mp4");

  return (
    <div
      data-testid="sticker-overlay-canvas-root"
      className={cn("pointer-events-auto absolute", className)}
      style={{
        left: centerLeft,
        top: centerTop,
        width: boxWidth,
        height: boxHeight,
        transform: `translate(-50%, -50%) rotate(${currentTransform.rotation}deg)`,
        transformOrigin: "center center",
        opacity,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.();
      }}
    >
      {/* Visual Content Layer */}
      <div
        className={cn(
          "relative h-full w-full select-none overflow-hidden rounded-md transition-shadow",
          isSelected ? "ring-2 ring-primary ring-offset-1" : "hover:ring-1 hover:ring-primary/50",
        )}
      >
        {isVideoFormat ? (
          <video
            src={sticker.url}
            autoPlay
            loop
            muted
            playsInline
            data-testid="sticker-gizmo-video"
            className="h-full w-full object-contain pointer-events-none"
          />
        ) : (
          <img
            src={sticker.url}
            alt={sticker.title ?? "sticker"}
            data-testid="sticker-gizmo-image"
            className="h-full w-full object-contain pointer-events-none"
          />
        )}

        {/* Center Drag Area */}
        <div
          data-testid="sticker-drag-handle-center"
          className="absolute inset-0 cursor-move bg-transparent"
          onPointerDown={(e) => handlePointerDown(e, "move")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      {/* Interactive Transform Gizmo (Only visible when selected) */}
      {isSelected && (
        <>
          {/* Top Rotation Stem & Handle */}
          <div className="absolute left-1/2 -top-7 -translate-x-1/2 flex flex-col items-center pointer-events-auto">
            <button
              type="button"
              data-testid="sticker-rotate-handle"
              className="flex size-4 cursor-grab items-center justify-center rounded-full border-2 border-white bg-primary shadow-sm hover:scale-125 active:cursor-grabbing"
              onPointerDown={(e) => handlePointerDown(e, "rotate")}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              title="Rotate"
            />
            <div className="h-3 w-0.5 bg-primary" />
          </div>

          {/* 4 Corner Scale Handles */}
          <button
            type="button"
            data-testid="sticker-scale-handle-tl"
            className="absolute -top-1.5 -left-1.5 size-3 cursor-nwse-resize rounded-full border-2 border-white bg-primary shadow-sm hover:scale-125"
            onPointerDown={(e) => handlePointerDown(e, "resize")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <button
            type="button"
            data-testid="sticker-scale-handle-tr"
            className="absolute -top-1.5 -right-1.5 size-3 cursor-nesw-resize rounded-full border-2 border-white bg-primary shadow-sm hover:scale-125"
            onPointerDown={(e) => handlePointerDown(e, "resize")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <button
            type="button"
            data-testid="sticker-scale-handle-bl"
            className="absolute -bottom-1.5 -left-1.5 size-3 cursor-nesw-resize rounded-full border-2 border-white bg-primary shadow-sm hover:scale-125"
            onPointerDown={(e) => handlePointerDown(e, "resize")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <button
            type="button"
            data-testid="sticker-scale-handle-br"
            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-full border-2 border-white bg-primary shadow-sm hover:scale-125"
            onPointerDown={(e) => handlePointerDown(e, "resize")}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />

          {/* Floating Readout & Action Badge */}
          <div
            data-testid="sticker-transform-badge"
            className="absolute -bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded bg-background/90 px-2 py-0.5 text-[10px] font-mono shadow-md backdrop-blur border whitespace-nowrap"
          >
            <span>
              {Math.round(currentTransform.x * 100)}%, {Math.round(currentTransform.y * 100)}%
            </span>
            <span className="text-muted-foreground">|</span>
            <span>{currentTransform.scale.toFixed(1)}x</span>
            {currentTransform.rotation !== 0 && (
              <>
                <span className="text-muted-foreground">|</span>
                <span>{currentTransform.rotation}°</span>
              </>
            )}

            <button
              type="button"
              data-testid="sticker-reset-button"
              onClick={handleReset}
              className="ml-1 text-muted-foreground hover:text-foreground"
              title="Reset Transform"
            >
              <RotateCcw className="size-2.5" />
            </button>

            {onDelete && (
              <button
                type="button"
                data-testid="sticker-delete-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="ml-0.5 text-destructive hover:text-destructive/80"
                title="Remove Sticker"
              >
                <Trash2 className="size-2.5" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
