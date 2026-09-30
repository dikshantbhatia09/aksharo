/**
 * The B-roll goldens (2026-10-05): a full-frame push in, a full-frame pan and
 * a picture-in-picture pull out, vertical and wide, fading in, in the middle
 * and fading out. Regenerated with the caption goldens
 * (`pnpm --filter @montaj/render-core golden:build`), into their own file, so a
 * change here can never hide among the caption or hook-title hashes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hashCommands } from "../commands/hash.js";
import { countCommands, walkCommands } from "../commands/types.js";
import {
  BROLL_CANVASES,
  BROLL_FIXTURES,
  BROLL_TIMESTAMPS_MS,
  brollGoldenCommands,
} from "../testing.js";

interface Entry {
  readonly fixture: string;
  readonly shape: string;
  readonly tMs: number;
  readonly commands: number;
  readonly hash: string;
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "goldens", "b-roll.json"), "utf8"),
) as { readonly entries: readonly Entry[] };

function draw(entry: Entry) {
  const overlay = BROLL_FIXTURES.find(
    (candidate) => `${candidate.mode}-${candidate.motion}` === entry.fixture,
  );
  const canvas = BROLL_CANVASES[entry.shape];
  if (overlay === undefined || canvas === undefined) {
    throw new Error(`no such golden input: ${entry.fixture}/${entry.shape}`);
  }
  return brollGoldenCommands(overlay, canvas, entry.tMs);
}

describe("b-roll goldens", () => {
  it("covers every fixture, shape and instant", () => {
    expect(golden.entries).toHaveLength(
      BROLL_FIXTURES.length * Object.keys(BROLL_CANVASES).length * BROLL_TIMESTAMPS_MS.length,
    );
  });

  it("reproduces every committed hash and command count", () => {
    const mismatches: string[] = [];
    for (const entry of golden.entries) {
      const commands = draw(entry);
      const hash = hashCommands(commands);
      if (hash !== entry.hash || countCommands(commands) !== entry.commands) {
        mismatches.push(`${entry.fixture}/${entry.shape}@${String(entry.tMs)}: ${hash}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("draws only the fixture's own picture, never text", () => {
    for (const entry of golden.entries) {
      const kinds = [...walkCommands(draw(entry))].map((command) => command.kind);
      expect(kinds).toContain("image");
      expect(kinds).not.toContain("text");
    }
  });
});
