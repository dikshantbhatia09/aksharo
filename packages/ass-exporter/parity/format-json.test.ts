/**
 * The formatting regression `parity/apply-flags.ts` and `parity/run.ts` both
 * depend on: their output must already satisfy `prettier --check`, or a CI
 * parity run dirties the tree the moment it writes anything (the bug this
 * module exists to fix — see `format-json.ts`'s doc comment).
 *
 * `JSON.stringify(x, null, 2)` disagrees with prettier about wrapping a short
 * array onto one line (prettier keeps `["a", "b", "c"]` inline when it fits
 * `printWidth`; `JSON.stringify` always breaks one element per line), which is
 * exactly the shape a `StyleDoc`'s `typography.fallbacks` has — so that field
 * is the fixture below, not an incidental detail. A second, sharper regression
 * — feeding prettier the *single-line* `JSON.stringify(value)` form instead of
 * the two-space-indented one — collapses every nested object onto one line
 * too (prettier only preserves an object's multi-line-ness from the source; a
 * single-line source has none to preserve), which is still `--check`-clean
 * but silently reformats every untouched field the moment the gate writes
 * anything at all. Both are covered below.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check } from "prettier";
import { describe, expect, it } from "vitest";

import { formatJson } from "./format-json.js";

const SAMPLE_STYLE_DOC = {
  id: "sample-style",
  name: "Sample Style",
  version: 2,
  category: "clean",
  minPlan: "free",
  typography: {
    fontFamily: "Inter",
    fallbacks: ["Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
    weight: 700,
    italic: false,
    sizePct: 6,
  },
  assRenderable: true,
  assExportable: true,
  requiresLayoutMetrics: false,
  parityScore: 0.9626,
};

describe("formatJson", () => {
  it("produces output prettier --check accepts, for a StyleDoc-shaped object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "montaj-format-json-"));
    try {
      // A real target path in the styles directory, so prettier resolves the
      // same config `apply-flags.ts` and `pnpm format:check` resolve for the
      // real files — the whole point of going through the Node API by path
      // rather than a hard-coded set of options.
      const target = join(dir, "sample-style.json");
      const formatted = await formatJson(SAMPLE_STYLE_DOC, target);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await writeFile(target, formatted, "utf8");

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      expect(await check(await readFile(target, "utf8"), { filepath: target })).toBe(true);
      // The short array stays on one line — this is the exact case a plain
      // `JSON.stringify(x, null, 2)` gets wrong.
      expect(formatted).toContain(
        '"fallbacks": ["Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"]',
      );
      expect(formatted.endsWith("\n")).toBe(true);
      expect(formatted.endsWith("\n\n")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a nested object expanded across lines rather than collapsing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "montaj-format-json-"));
    try {
      const target = join(dir, "sample-style.json");
      const formatted = await formatJson(SAMPLE_STYLE_DOC, target);
      const expandedTypography = ['"typography": {', '"fontFamily": "Inter",'].join("\n    ");
      expect(formatted).toContain(expandedTypography);
      // The narrow failure mode this guards: every object on one line.
      expect(formatted).not.toContain('"typography": { "fontFamily"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: formatting already-formatted output changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "montaj-format-json-"));
    try {
      const target = join(dir, "results.json");
      const once = await formatJson(
        { generatedAt: "2026-01-01T00:00:00.000Z", styles: {} },
        target,
      );
      const twice = await formatJson(JSON.parse(once) as unknown, target);
      expect(twice).toBe(once);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
