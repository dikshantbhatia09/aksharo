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
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_CANVAS,
  GOLDEN_TIMESTAMPS_MS,
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
    writeFileSync(join(GOLDEN_DIR, `${fixture.name}.json`), snapshotJson(snapshot), "utf8");
  }

  writeFileSync(
    join(GOLDEN_DIR, "hashes.json"),
    `${JSON.stringify({ canvas: GOLDEN_CANVAS, entries: hashes }, null, 1)}\n`,
    "utf8",
  );
  console.log(`wrote ${String(hashes.length)} golden hashes and ${String(CAPTION_FIXTURES.length)} snapshots`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
