/**
 * Regenerates the PNG baselines and the command lists the browser test replays.
 *
 * Run it after a deliberate change to layout, animation or the executor, look at
 * the images, and commit them with the change:
 *
 *   pnpm --filter @montaj/render-canvaskit baseline:build
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CanvasKitBackend } from "../src/backend.js";
import { BASELINE_BACKGROUND, BASELINE_CANVAS, BASELINE_FRAMES } from "../src/frames.js";
import { buildBaselineCommands, loadFixtureFonts } from "../src/testing.js";

export const BASELINE_DIR = join(__dirname, "..", "fixtures", "baselines");

async function main(): Promise<void> {
  mkdirSync(BASELINE_DIR, { recursive: true });
  const fonts = loadFixtureFonts();
  const backend = await CanvasKitBackend.create({ fonts });
  const commands = await buildBaselineCommands();

  try {
    for (const frame of BASELINE_FRAMES) {
      const list = commands[frame.name];
      if (list === undefined) throw new Error(`no commands for ${frame.name}`);
      const png = backend.renderToPng(list, {
        width: BASELINE_CANVAS.width,
        height: BASELINE_CANVAS.height,
        background: BASELINE_BACKGROUND,
      });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      writeFileSync(join(BASELINE_DIR, `${frame.name}.png`), png);
      console.log(`${frame.name}.png — ${String(png.length)} bytes`);
    }
    writeFileSync(
      join(BASELINE_DIR, "commands.json"),
      `${JSON.stringify(
        {
          canvas: BASELINE_CANVAS,
          background: BASELINE_BACKGROUND,
          frames: Object.fromEntries(
            BASELINE_FRAMES.map((frame) => [frame.name, commands[frame.name] ?? []]),
          ),
        },
        null,
        1,
      )}\n`,
      "utf8",
    );
    console.log(`wrote ${String(BASELINE_FRAMES.length)} baselines to fixtures/baselines`);
  } finally {
    backend.dispose();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
