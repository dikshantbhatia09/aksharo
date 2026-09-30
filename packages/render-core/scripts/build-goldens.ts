/**
 * Regenerates the golden `DrawCommand[]` fixtures.
 *
 * Run it after a deliberate change to layout or animation, read the diff, and
 * commit both the code and the goldens in one commit — a golden that moves
 * without a reviewed reason is exactly the regression this suite exists to
 * catch. A18a's cross-backend parity gate consumes `hashes.json`.
 *
 *   pnpm --filter @montaj/render-core golden:build
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSystemStyles } from "@montaj/caption-styles";

import { animate } from "../src/animate/animate.js";
import { hashCommands } from "../src/commands/hash.js";
import { countCommands } from "../src/commands/types.js";
import { layoutSegment } from "../src/layout/layout.js";
import {
  BROLL_CANVASES,
  BROLL_FIXTURES,
  BROLL_TIMESTAMPS_MS,
  brollGoldenCommands,
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_CANVAS,
  GOLDEN_TIMESTAMPS_MS,
  HOOK_TITLE_CANVASES,
  HOOK_TITLE_FIXTURES,
  HOOK_TITLE_TIMESTAMPS_MS,
  hookTitleGoldenCommands,
} from "../src/testing.js";

export const GOLDEN_DIR = join(__dirname, "..", "fixtures", "goldens");

/** The timestamp whose full command list is committed, not just its hash. */
export const SNAPSHOT_MS = 1500;

interface HashEntry {
  readonly style: string;
  readonly fixture: string;
  readonly tMs: number;
  readonly commands: number;
  readonly hash: string;
}

/**
 * One style per line, compact. Pretty-printing a glyph-position array helps
 * nobody; one line per style means a diff names exactly which styles moved.
 */
function snapshotJson(snapshot: Record<string, unknown>): string {
  const lines = Object.entries(snapshot).map(
    ([id, commands]) => `  ${JSON.stringify(id)}: ${JSON.stringify(commands)}`,
  );
  return `{\n "canvas": ${JSON.stringify(GOLDEN_CANVAS)},\n "tMs": ${String(SNAPSHOT_MS)},\n "styles": {\n${lines.join(",\n")}\n }\n}\n`;
}

async function main(): Promise<void> {
  const { registry, shaper } = await createFixtureRenderer();
  const styles = loadSystemStyles();
  mkdirSync(GOLDEN_DIR, { recursive: true });

  const hashes: HashEntry[] = [];
  for (const fixture of CAPTION_FIXTURES) {
    const snapshot: Record<string, unknown> = {};
    for (const style of styles) {
      for (const tMs of GOLDEN_TIMESTAMPS_MS) {
        const layout = layoutSegment({
          style,
          segment: fixture.segment,
          words: fixture.words,
          canvas: GOLDEN_CANVAS,
          registry,
          shaper,
          tMs,
        });
        const commands = animate({ layout, style, tMs });
        hashes.push({
          style: style.id,
          fixture: fixture.name,
          tMs,
          commands: countCommands(commands),
          hash: hashCommands(commands),
        });
        if (tMs === SNAPSHOT_MS) snapshot[style.id] = commands;
      }
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    writeFileSync(join(GOLDEN_DIR, `${fixture.name}.json`), snapshotJson(snapshot), "utf8");
  }

  writeFileSync(
    join(GOLDEN_DIR, "hashes.json"),
    `${JSON.stringify({ canvas: GOLDEN_CANVAS, entries: hashes }, null, 1)}\n`,
    "utf8",
  );
  // The hook title (2026-09-29), in the default style: its own file, so a
  // change to it can never be mistaken for a change to a caption.
  const punchPop = styles.find((style) => style.id === "punch-pop");
  if (punchPop === undefined) throw new Error("punch-pop is missing from the catalogue");
  const hookEntries: HookTitleEntry[] = [];
  for (const fixture of HOOK_TITLE_FIXTURES) {
    for (const [shape, canvas] of Object.entries(HOOK_TITLE_CANVASES)) {
      for (const tMs of HOOK_TITLE_TIMESTAMPS_MS) {
        const commands = hookTitleGoldenCommands(punchPop, fixture.text, canvas, tMs, {
          registry,
          shaper,
        });
        hookEntries.push({
          fixture: fixture.name,
          shape,
          tMs,
          commands: countCommands(commands),
          hash: hashCommands(commands),
        });
      }
    }
  }
  writeFileSync(
    join(GOLDEN_DIR, "hook-title.json"),
    `${JSON.stringify({ style: "punch-pop", entries: hookEntries }, null, 1)}\n`,
    "utf8",
  );
  // B-roll cutaways (2026-10-05): their own file too. No style: a cutaway is
  // a picture, and is drawn the same under any caption style.
  const brollEntries: HookTitleEntry[] = [];
  for (const overlay of BROLL_FIXTURES) {
    for (const [shape, canvas] of Object.entries(BROLL_CANVASES)) {
      for (const tMs of BROLL_TIMESTAMPS_MS) {
        const commands = brollGoldenCommands(overlay, canvas, tMs);
        brollEntries.push({
          fixture: `${overlay.mode}-${overlay.motion}`,
          shape,
          tMs,
          commands: countCommands(commands),
          hash: hashCommands(commands),
        });
      }
    }
  }
  writeFileSync(
    join(GOLDEN_DIR, "b-roll.json"),
    `${JSON.stringify({ entries: brollEntries }, null, 1)}\n`,
    "utf8",
  );
  console.log(
    `wrote ${String(hashes.length)} golden hashes, ${String(CAPTION_FIXTURES.length)} snapshots, ${String(hookEntries.length)} hook-title hashes and ${String(brollEntries.length)} b-roll hashes`,
  );
}

interface HookTitleEntry {
  readonly fixture: string;
  readonly shape: string;
  readonly tMs: number;
  readonly commands: number;
  readonly hash: string;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
