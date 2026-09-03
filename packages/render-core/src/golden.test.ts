/**
 * The golden suite: every system style × the four caption fixtures (Hinglish,
 * Hindi, Tamil, English) × three instants, compared against committed
 * `DrawCommand[]` and their hashes.
 *
 * A hash that moves is not automatically a failure — it is a change to the
 * pixels every backend will draw. Regenerate with
 * `pnpm --filter @montaj/render-core golden:build`, read the diff, and commit
 * the reason with it. A18a's parity gate re-computes the same hashes on
 * CanvasKit and on `@napi-rs/canvas`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { animate } from "./animate/animate.js";
import { hashCommands } from "./commands/hash.js";
import { countCommands, type DrawCommand, walkCommands } from "./commands/types.js";
import { type Shaper } from "./fonts/shaper.js";
import { type FontRegistry } from "./fonts/types.js";
import { layoutSegment } from "./layout/layout.js";
import {
  CAPTION_FIXTURES,
  createFixtureRenderer,
  GOLDEN_CANVAS,
  GOLDEN_TIMESTAMPS_MS,
} from "./testing.js";

const GOLDEN_DIR = join(__dirname, "..", "fixtures", "goldens");
const SNAPSHOT_MS = 1500;

interface HashEntry {
  style: string;
  fixture: string;
  tMs: number;
  commands: number;
  hash: string;
}

function readJson<T>(name: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8")) as T;
}

const styles = loadSystemStyles();
let registry: FontRegistry;
let shaper: Shaper;

beforeAll(async () => {
  ({ registry, shaper } = await createFixtureRenderer());
});

function render(styleId: string, fixtureName: string, tMs: number): DrawCommand[] {
  const style = styles.find((entry) => entry.id === styleId);
  const fixture = CAPTION_FIXTURES.find((entry) => entry.name === fixtureName);
  if (style === undefined || fixture === undefined) {
    throw new Error(`no such golden input: ${styleId} / ${fixtureName}`);
  }
  const layout = layoutSegment({
    style,
    segment: fixture.segment,
    words: fixture.words,
    canvas: GOLDEN_CANVAS,
    registry,
    shaper,
    tMs,
  });
  return animate({ layout, style, tMs });
}

describe("golden hashes", () => {
  const golden = readJson<{ entries: HashEntry[] }>("hashes.json");

  it("covers every style, fixture and timestamp", () => {
    expect(golden.entries).toHaveLength(
      styles.length * CAPTION_FIXTURES.length * GOLDEN_TIMESTAMPS_MS.length,
    );
    expect(styles).toHaveLength(30);
  });

  it("reproduces every committed hash", () => {
    const mismatches: string[] = [];
    for (const entry of golden.entries) {
      const commands = render(entry.style, entry.fixture, entry.tMs);
      const hash = hashCommands(commands);
      // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
      if (hash !== entry.hash) {
        mismatches.push(
          `${entry.style}/${entry.fixture}@${String(entry.tMs)}: ${hash} ≠ ${entry.hash}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("reproduces every committed command count", () => {
    for (const entry of golden.entries.filter((candidate) => candidate.tMs === SNAPSHOT_MS)) {
      expect(
        countCommands(render(entry.style, entry.fixture, entry.tMs)),
        `${entry.style}/${entry.fixture}`,
      ).toBe(entry.commands);
    }
  });

  it("draws something for every style and fixture", () => {
    // A single instant may legitimately be empty — an entry animation is at
    // zero opacity on the frame it starts, and a per-word style restarts its
    // entry at every word — but a style that never draws anything is broken.
    const drawn = new Map<string, number>();
    for (const entry of golden.entries) {
      const key = `${entry.style}/${entry.fixture}`;
      drawn.set(key, (drawn.get(key) ?? 0) + entry.commands);
    }
    expect([...drawn.entries()].filter(([, commands]) => commands === 0)).toEqual([]);
    expect(drawn.size).toBe(styles.length * CAPTION_FIXTURES.length);
  });
});

describe.each(CAPTION_FIXTURES.map((fixture) => fixture.name))(
  "golden snapshot: %s",
  (fixtureName) => {
    const snapshot = readJson<{ styles: Record<string, DrawCommand[]> }>(`${fixtureName}.json`);

    it("matches the committed DrawCommand[] for every style", () => {
      for (const style of styles) {
        const expected = snapshot.styles[style.id];
        expect(expected, `${style.id} is missing from the ${fixtureName} snapshot`).toBeDefined();
        expect(render(style.id, fixtureName, SNAPSHOT_MS), `${style.id}/${fixtureName}`).toEqual(
          expected,
        );
      }
    });

    it("draws text with glyph ids and paired positions", () => {
      for (const commands of Object.values(snapshot.styles)) {
        for (const command of walkCommands(commands)) {
          if (command.kind !== "text") continue;
          expect(command.run.positions).toHaveLength(command.run.glyphs.length * 2);
          expect(command.run.clusters).toHaveLength(command.run.glyphs.length);
          expect(command.run.fontSizePx).toBeGreaterThan(0);
        }
      }
    });

    it("shapes the Indic fixtures with real glyphs, never notdef", () => {
      if (fixtureName !== "hindi" && fixtureName !== "tamil") return;
      for (const commands of Object.values(snapshot.styles)) {
        for (const command of walkCommands(commands)) {
          if (command.kind !== "text") continue;
          expect(command.run.glyphs, "a .notdef glyph means the fallback failed").not.toContain(0);
        }
      }
    });
  },
);

describe("determinism", () => {
  it("returns identical commands for the same inputs, ten times over", () => {
    for (const style of styles.slice(0, 10)) {
      for (const fixture of CAPTION_FIXTURES) {
        const first = hashCommands(render(style.id, fixture.name, 1234));
        for (let attempt = 0; attempt < 9; attempt += 1) {
          expect(
            hashCommands(render(style.id, fixture.name, 1234)),
            `${style.id}/${fixture.name}`,
          ).toBe(first);
        }
      }
    }
  });

  it("changes the commands when, and only when, time moves", () => {
    const style = styles.find((entry) => entry.id === "karaoke-fill");
    expect(style).toBeDefined();
    const at = (tMs: number): string => hashCommands(render("karaoke-fill", "english", tMs));
    expect(at(1500)).toBe(at(1500));
    expect(at(1500)).not.toBe(at(1600));
  });

  it("orders the JSON identically whatever order the keys were built in", () => {
    const commands = render("punch-pop", "hinglish", 1500);
    const shuffled = JSON.parse(JSON.stringify(commands)) as DrawCommand[];
    expect(hashCommands(shuffled)).toBe(hashCommands(commands));
  });
});
