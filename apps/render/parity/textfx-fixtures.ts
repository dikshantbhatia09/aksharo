/**
 * D06b text-fx parity fixture: one title per motion preset, each running
 * across a 6-second clip, rendered with the exact shared step
 * (`renderTitleFrame`, `@montaj/render-core`) both `apps/web/lib/export/
 * engine.ts` and this app's own `../src/render/frames.ts` call — so what this
 * fixture measures is whatever the two rasterisers (CanvasKit, Skia-node)
 * disagree on when handed the *same* `DrawCommand[]`, not whether the two
 * apps built the same commands (that is guaranteed by construction: one
 * function, one call site in each app).
 *
 * No caption is on screen in this fixture (`captionBox` is left `undefined`):
 * `placeTitleBox` then always resolves to `top-third`, which keeps every
 * preset's sampled frame comparable to the others rather than each landing in
 * a different slot.
 */
import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";
import {
  createFontRegistry,
  createHarfBuzzShaper,
  renderTitleFrame,
  type CanvasSize,
  type DrawCommand,
  type FontRegistry,
  type Shaper,
  type TextFxMotionPreset,
} from "@montaj/render-core";
import { GOLDEN_CANVAS, loadFixtureFonts } from "@montaj/render-core/testing";

export const TEXTFX_CANVAS: CanvasSize = GOLDEN_CANVAS;
export const TEXTFX_CLIP_MS = 6_000;
/** Entry, mid-hold and exit — the three instants every preset's own curve changes shape at. */
export const TEXTFX_SAMPLE_MS: readonly number[] = [120, 3_000, 5_900];

interface TextFxPresetFixture {
  readonly preset: TextFxMotionPreset;
  readonly text: string;
}

/** One title per preset (D06's six), each spanning the whole clip. */
export const TEXTFX_PRESET_FIXTURES: readonly TextFxPresetFixture[] = [
  { preset: "pop", text: "New drop today" },
  { preset: "slide-up", text: "Behind the scenes" },
  { preset: "typewriter", text: "Type it out" },
  { preset: "underline", text: "Read this twice" },
  { preset: "count-up", text: "12,000 views" },
  { preset: "fade", text: "Thanks for watching" },
];

export interface TextFxParityFrame {
  readonly name: string;
  readonly preset: TextFxMotionPreset;
  readonly tMs: number;
  readonly commands: DrawCommand[];
}

export interface TextFxRenderer {
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  readonly style: StyleDoc;
}

/** The registry/shaper/style every sample below renders with. */
export async function createTextFxRenderer(): Promise<TextFxRenderer> {
  const registry = createFontRegistry(loadFixtureFonts());
  const shaper = await createHarfBuzzShaper(registry);
  const style = loadSystemStyleMap().get("vertical-clean");
  if (style === undefined) throw new Error("fixture style 'vertical-clean' is missing");
  return { registry, shaper, style };
}

/** Every (preset × sample instant) frame, built with the one shared drawer. */
export function buildTextFxFrames(renderer: TextFxRenderer): TextFxParityFrame[] {
  const frames: TextFxParityFrame[] = [];
  for (const fixture of TEXTFX_PRESET_FIXTURES) {
    for (const tMs of TEXTFX_SAMPLE_MS) {
      const commands = renderTitleFrame({
        titles: [
          {
            itemId: `title-${fixture.preset}`,
            startMs: 0,
            endMs: TEXTFX_CLIP_MS,
            text: fixture.text,
            motionPreset: fixture.preset,
          },
        ],
        timemap: null,
        outputMs: tMs,
        canvas: TEXTFX_CANVAS,
        registry: renderer.registry,
        shaper: renderer.shaper,
        style: renderer.style,
      });
      frames.push({
        name: `${fixture.preset}-${String(tMs)}`,
        preset: fixture.preset,
        tMs,
        commands,
      });
    }
  }
  return frames;
}
