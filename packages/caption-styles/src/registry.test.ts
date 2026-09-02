import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isCompliantStyleName } from "./naming.js";
import {
  loadStyleRegistry,
  loadSystemStyleMap,
  loadSystemStyles,
  REGISTRY_FILENAME,
  StyleCatalogueError,
  STYLES_DIR,
  stylesInCategory,
} from "./registry.js";

const scratchDirs: string[] = [];

function scratch(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "montaj-styles-"));
  scratchDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
      "utf8",
    );
  }
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadSystemStyles", () => {
  const styles = loadSystemStyles();

  it("returns every shipped style, validated and ordered", () => {
    // A16 drew the rest of the catalogue: the registry and the documents are
    // now the same 30 styles, in id order.
    expect(styles).toHaveLength(30);
    expect(styles.map((style) => style.id)).toEqual(
      [...loadStyleRegistry().styles.map((entry) => entry.id)].sort(),
    );
  });

  it("ships the keys A03's database seed expects", () => {
    const ids = new Set(styles.map((style) => style.id));
    for (const required of [
      "punch-pop",
      "hype-bold",
      "karaoke-fill",
      "word-pop",
      "minimal-lower-third",
    ]) {
      expect(ids, `seed key ${required} is missing`).toContain(required);
    }
  });

  it("has parity flags written by the A18a gate for every shipped style (D33)", () => {
    // Before the A18a gate ever runs, every style ships the conservative
    // pre-gate defaults (`false`/`false`/`true`/`undefined` — see
    // `schema.test.ts`'s "defaults the parity flags to the pre-gate answer").
    // Once `packages/ass-exporter/parity/run.ts` + `apply-flags.ts` have run —
    // which they have, for this checkout's `styles/*.json` — every style
    // instead carries the gate's own measured answer: `assExportable` is
    // always true (a readable `.ass` sidecar is always producible),
    // `parityScore` is a real number in `[0, 1]`, and `assRenderable` is
    // whatever the measured CanvasKit/Skia/libass diff actually found. The
    // flags are never hand-edited (D33), so this test is really asserting
    // "the gate has run and its numbers look sane", not any particular value.
    for (const style of styles) {
      expect(style.assExportable, style.id).toBe(true);
      expect(typeof style.assRenderable, style.id).toBe("boolean");
      expect(typeof style.requiresLayoutMetrics, style.id).toBe("boolean");
      expect(style.parityScore, style.id).toBeGreaterThanOrEqual(0);
      expect(style.parityScore, style.id).toBeLessThanOrEqual(1);
    }
  });

  it("ships an Indic fallback and at least one emphasis preset per style", () => {
    for (const style of styles) {
      expect(style.typography.fallbacks ?? [], style.id).toContain("Noto Sans Devanagari");
      expect(style.emphasisPresets.length, style.id).toBeGreaterThan(0);
    }
  });

  it("keys the styles by id", () => {
    expect([...loadSystemStyleMap().keys()].sort()).toEqual(styles.map((style) => style.id));
  });

  it("rejects a style whose file name does not match its id", () => {
    const dir = scratch({
      "wrong-name.json": readFileSync(join(STYLES_DIR, "punch-pop.json"), "utf8"),
    });
    expect(() => loadSystemStyles(dir)).toThrow(/file must be <id>\.json/);
  });

  it("rejects an invalid style document", () => {
    const dir = scratch({ "broken.json": { id: "broken", name: "Broken" } });
    expect(() => loadSystemStyles(dir)).toThrow(StyleCatalogueError);
  });

  it("rejects unreadable JSON", () => {
    const dir = scratch({ "punch-pop.json": "{ not json" });
    expect(() => loadSystemStyles(dir)).toThrow(/cannot read/);
  });
});

describe("styles/registry.json", () => {
  const registry = loadStyleRegistry();

  it("lists the 30 planned styles", () => {
    expect(registry.styles).toHaveLength(30);
    expect(new Set(registry.styles.map((entry) => entry.id)).size).toBe(30);
  });

  it("marks exactly the styles with a document as shipped", () => {
    const shipped = registry.styles
      .filter((entry) => entry.status === "shipped")
      .map((entry) => entry.id);
    expect(shipped.sort()).toEqual(loadSystemStyles().map((style) => style.id));
  });

  it("has a document for every shipped entry and an entry for every document", () => {
    const documents = loadSystemStyleMap();
    for (const entry of registry.styles) {
      const document = documents.get(entry.id);
      if (entry.status === "shipped") {
        expect(document, `${entry.id} is shipped but has no document`).toBeDefined();
        expect(document?.name).toBe(entry.name);
        expect(document?.category).toBe(entry.category);
      } else {
        expect(document, `${entry.id} is planned but already has a document`).toBeUndefined();
      }
    }
  });

  it("passes the naming rule for every planned name (D64)", () => {
    for (const entry of registry.styles) {
      expect(isCompliantStyleName(entry), `${entry.id} breaks the naming rule`).toBe(true);
    }
  });

  it("filters by category", () => {
    const bold = stylesInCategory("bold");
    expect(bold.map((entry) => entry.id)).toContain("punch-pop");
    expect(bold.every((entry) => entry.category === "bold")).toBe(true);
    expect(stylesInCategory("gaming").length).toBeGreaterThan(0);
  });

  it("rejects a malformed registry", () => {
    const dir = scratch({ [REGISTRY_FILENAME]: { version: 2, styles: [] } });
    expect(() => loadStyleRegistry(dir)).toThrow(/registry\.json is invalid/);
  });
});
