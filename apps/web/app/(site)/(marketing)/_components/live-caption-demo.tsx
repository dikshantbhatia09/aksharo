"use client";

/**
 * The home hero's live demo: a bundled 15-second Hinglish mock transcript
 * (`content/site/demo-transcript.ts`), rendered by the real renderer
 * (`@montaj/render-canvaskit` + `@montaj/render-core`, the same pipeline
 * `StylePreviewCanvas` uses for the editor's style picker), with a style
 * switcher. No ASR call — this is a bundled sample, not a live transcription of
 * anything the visitor uploads (a real upload demo is the signed-up product).
 *
 * There is no bundled sample video (none was available to this work package,
 * reported as a deviation): the caption overlay draws over a static 9:16
 * placeholder frame rather than real footage.
 */

import { useEffect, useRef, useState } from "react";

import { animate, layoutSegment, type WordScript } from "@montaj/render-core";

import { useRenderer } from "@/components/editor/canvas/use-canvaskit";
import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import {
  DEMO_DURATION_MS,
  DEMO_PLAIN_TEXT,
  DEMO_SCRIPT,
  DEMO_SEGMENT,
  DEMO_STYLE_IDS,
  DEMO_WORDS,
} from "@/content/site/demo-transcript";
import { cn } from "@/lib/utils";

const TILE_WIDTH = 288;
const TILE_HEIGHT = 512;

type DemoStage = "transcribing" | "ready";

export function LiveCaptionDemo(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { backend, engine, error, loading } = useRenderer();
  const [styleId, setStyleId] = useState(DEMO_STYLE_IDS[0] ?? "punch-pop");
  const [stage, setStage] = useState<DemoStage>("transcribing");
  const [playing, setPlaying] = useState(true);

  // A short, honest "transcribing" beat before the captions appear — this is a
  // simulated demo (no ASR call), and pretending otherwise would be exactly the
  // kind of overstatement the rest of this work package avoids.
  useEffect(() => {
    const timer = setTimeout(() => {
      setStage("ready");
    }, 900);
    return (): void => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null || backend === undefined || engine === undefined || stage !== "ready") {
      return;
    }

    const style = SYSTEM_STYLE_MAP.get(styleId);
    if (style === undefined) return;

    element.width = TILE_WIDTH;
    element.height = TILE_HEIGHT;
    const surface = backend.ck.MakeSWCanvasSurface(element);
    if (surface === null) return;

    let frame = 0;
    let start = 0;
    let cancelled = false;

    const draw = (now: number): void => {
      if (cancelled) return;
      if (start === 0) start = now;
      const tMs = playing ? (now - start) % DEMO_DURATION_MS : 0;
      const layout = layoutSegment({
        style,
        segment: DEMO_SEGMENT,
        words: DEMO_WORDS,
        canvas: { width: TILE_WIDTH, height: TILE_HEIGHT },
        registry: engine.registry,
        shaper: engine.shaper,
        tMs,
      });
      backend.drawFrame(surface.getCanvas(), animate({ layout, style, tMs }), {
        background: "#15151cff",
      });
      surface.flush();
      if (playing) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return (): void => {
      cancelled = true;
      cancelAnimationFrame(frame);
      surface.delete();
    };
  }, [backend, engine, stage, styleId, playing]);

  const state = error !== undefined ? "error" : loading || stage !== "ready" ? "loading" : "ready";

  return (
    <div className="flex flex-col items-center gap-4" data-testid="live-caption-demo">
      <div
        className="border-border relative overflow-hidden rounded-lg border bg-black shadow-[var(--shadow-panel)]"
        style={{ width: TILE_WIDTH, height: TILE_HEIGHT }}
      >
        {/* A placeholder frame stands in for real footage — see the file header. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(216,255,61,0.12),transparent_55%),linear-gradient(160deg,#1b1b22,#0b0b0e_70%)]"
        />
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Live caption preview: ${DEMO_PLAIN_TEXT}`}
          data-testid="live-caption-demo-canvas"
          data-state={state}
          className="relative block h-full w-full"
        />
        {stage === "transcribing" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span
              className="border-fg-2 border-t-lime-500 size-8 animate-spin rounded-full border-2"
              aria-hidden="true"
            />
            <span className="sr-only">Transcribing the sample clip…</span>
          </div>
        ) : null}
        <span className="text-fg-2 bg-bg-0/70 absolute top-2 right-2 rounded-full px-2 py-0.5 text-2xs">
          Sample clip · no upload
        </span>
      </div>

      <div
        className="flex flex-wrap justify-center gap-2"
        role="group"
        aria-label="Caption style"
        data-testid="live-caption-demo-switcher"
      >
        {DEMO_STYLE_IDS.map((id) => {
          const style = SYSTEM_STYLE_MAP.get(id);
          if (style === undefined) return null;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={styleId === id}
              onClick={() => {
                setStyleId(id);
              }}
              data-testid={`live-caption-demo-style-${id}`}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                styleId === id
                  ? "border-lime-500 bg-lime-500/10 text-lime-500"
                  : "border-border text-fg-1 hover:text-fg-0 hover:bg-bg-2",
              )}
            >
              {style.name}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setPlaying((value) => !value);
          }}
          data-testid="live-caption-demo-toggle-play"
          className="border-border text-fg-1 hover:text-fg-0 hover:bg-bg-2 rounded-full border px-3 py-1.5 text-xs font-medium"
        >
          {playing ? "Pause" : "Play"}
        </button>
      </div>
    </div>
  );
}

/** Exported for tests that need the script the demo previews in. */
export const DEMO_PREVIEW_SCRIPT: WordScript = DEMO_SCRIPT;
