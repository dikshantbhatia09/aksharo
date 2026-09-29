/**
 * The hook title's goldens (2026-09-29): a Hinglish and a Hindi hook, vertical
 * and wide, at entry, middle and exit, in Punch Pop. Regenerated with the
 * caption goldens (`pnpm --filter @montaj/render-core golden:build`), into
 * their own file, so a change here can never hide among the caption hashes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";

import { hashCommands } from "../commands/hash.js";
import { countCommands, walkCommands } from "../commands/types.js";
import {
  createFixtureRenderer,
  type FixtureRenderer,
  HOOK_TITLE_CANVASES,
  HOOK_TITLE_FIXTURES,
  HOOK_TITLE_TIMESTAMPS_MS,
  hookTitleGoldenCommands,
} from "../testing.js";

interface Entry {
  readonly fixture: string;
  readonly shape: string;
  readonly tMs: number;
  readonly commands: number;
  readonly hash: string;
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "goldens", "hook-title.json"), "utf8"),
) as { readonly style: string; readonly entries: readonly Entry[] };

const style = loadSystemStyleMap().get("punch-pop");
let renderer: FixtureRenderer;

beforeAll(async () => {
  renderer = await createFixtureRenderer();
});

function draw(entry: Entry) {
  const fixture = HOOK_TITLE_FIXTURES.find((candidate) => candidate.name === entry.fixture);
  const canvas = HOOK_TITLE_CANVASES[entry.shape];
  if (fixture === undefined || canvas === undefined || style === undefined) {
    throw new Error(`no such golden input: ${entry.fixture}/${entry.shape}`);
  }
  return hookTitleGoldenCommands(style, fixture.text, canvas, entry.tMs, renderer);
}

describe("hook-title goldens", () => {
  it("covers every fixture, shape and instant", () => {
    expect(golden.style).toBe("punch-pop");
    expect(golden.entries).toHaveLength(
      HOOK_TITLE_FIXTURES.length *
        Object.keys(HOOK_TITLE_CANVASES).length *
        HOOK_TITLE_TIMESTAMPS_MS.length,
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

  it("draws real glyphs for the Hindi hook, never notdef", () => {
    for (const entry of golden.entries.filter((candidate) => candidate.fixture === "hindi")) {
      for (const command of walkCommands(draw(entry))) {
        if (command.kind !== "text") continue;
        expect(command.run.glyphs).not.toContain(0);
      }
    }
  });
});
