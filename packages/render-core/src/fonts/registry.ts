/**
 * The in-memory font registry and the family-resolution rule.
 *
 * Resolution order for one run of text:
 *
 * 1. the style's own family, at the closest available weight and slant;
 * 2. the style's `fallbacks`, in the order the document lists them;
 * 3. any registered face whose declared `scripts` include the run's script;
 * 4. any registered face at all that covers the code points.
 *
 * A face only qualifies if it can draw **every** code point in the run, which
 * is what makes a Hinglish line split into a Latin run and a Devanagari run
 * instead of drawing tofu.
 */

import { RenderError } from "../errors.js";
import { type WordScript } from "../script.js";
import { type FontQuery, type FontRegistry, type FontResource } from "./types.js";

/** Reads the character map of a TTF/OTF so coverage does not need HarfBuzz. */
function readCharacterMap(data: Uint8Array): Set<number> {
  const covered = new Set<number>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12) return covered;

  const numTables = view.getUint16(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > data.byteLength) break;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    if (tag === "cmap") {
      cmapOffset = view.getUint32(record + 8);
      break;
    }
  }
  if (cmapOffset < 0 || cmapOffset + 4 > data.byteLength) return covered;

  // Prefer a Unicode subtable: (3,10) full repertoire, then (3,1) BMP, then (0,*).
  const tableCount = view.getUint16(cmapOffset + 2);
  let best = -1;
  let bestRank = -1;
  for (let i = 0; i < tableCount; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    if (record + 8 > data.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = view.getUint32(record + 4);
    const rank =
      platform === 3 && encoding === 10
        ? 3
        : platform === 3 && encoding === 1
          ? 2
          : platform === 0
            ? 1
            : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = cmapOffset + offset;
    }
  }
  if (best < 0 || best + 4 > data.byteLength) return covered;

  const format = view.getUint16(best);
  if (format === 4) {
    const segCountX2 = view.getUint16(best + 6);
    const segCount = segCountX2 / 2;
    const endBase = best + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let s = 0; s < segCount; s += 1) {
      if (rangeBase + s * 2 + 2 > data.byteLength) break;
      const end = view.getUint16(endBase + s * 2);
      const start = view.getUint16(startBase + s * 2);
      if (start > end || start === 0xffff) continue;
      const rangeOffset = view.getUint16(rangeBase + s * 2);
      for (let code = start; code <= end; code += 1) {
        if (rangeOffset === 0) {
          covered.add(code);
          continue;
        }
        const glyphIndexAddress = rangeBase + s * 2 + rangeOffset + (code - start) * 2;
        if (glyphIndexAddress + 2 > data.byteLength) break;
        if (view.getUint16(glyphIndexAddress) !== 0) covered.add(code);
      }
    }
    return covered;
  }
  if (format === 12) {
    const groupCount = view.getUint32(best + 12);
    for (let g = 0; g < groupCount; g += 1) {
      const record = best + 16 + g * 12;
      if (record + 12 > data.byteLength) break;
      const start = view.getUint32(record);
      const end = view.getUint32(record + 4);
      // Guard against a pathological table claiming the whole plane.
      if (end - start > 0x10000) continue;
      for (let code = start; code <= end; code += 1) covered.add(code);
    }
  }
  return covered;
}

interface Entry {
  readonly font: FontResource;
  readonly familyKey: string;
  readonly covered: Set<number>;
}

function familyKey(family: string): string {
  return family.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * CSS-ish weight distance: an exact match wins, then the same side of 400, then
 * anything. Slant mismatch costs more than any weight gap so an upright face is
 * never swapped for an italic when both exist.
 */
function faceDistance(font: FontResource, query: FontQuery): number {
  const slant = font.italic === query.italic ? 0 : 10_000;
  return slant + Math.abs(font.weight - query.weight);
}

class InMemoryFontRegistry implements FontRegistry {
  readonly #byId = new Map<string, Entry>();
  readonly #order: string[] = [];

  register(font: FontResource): void {
    if (font.id.length === 0) {
      throw new RenderError("render/invalid-input", "a font resource needs a non-empty id");
    }
    if (font.data.byteLength === 0) {
      throw new RenderError("render/invalid-input", `font "${font.id}" has no data`, {
        id: font.id,
      });
    }
    if (!this.#byId.has(font.id)) this.#order.push(font.id);
    this.#byId.set(font.id, {
      font,
      familyKey: familyKey(font.family),
      covered: readCharacterMap(font.data),
    });
  }

  list(): readonly FontResource[] {
    return this.#order.map((id) => {
      const entry = this.#byId.get(id);
      if (entry === undefined) throw new RenderError("render/no-font", `font "${id}" vanished`);
      return entry.font;
    });
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  get(id: string): FontResource | undefined {
    return this.#byId.get(id)?.font;
  }

  /** All code points are drawable by this face (an empty run is drawable by any). */
  #covers(entry: Entry, codePoints: readonly number[] | undefined): boolean {
    if (codePoints === undefined) return true;
    for (const code of codePoints) {
      // Whitespace is layout, not a glyph: never let a space decide a fallback.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x200c || code === 0x200d) {
        continue;
      }
      if (!entry.covered.has(code)) return false;
    }
    return true;
  }

  #bestInFamily(
    family: string,
    query: FontQuery,
    codePoints: readonly number[] | undefined,
  ): FontResource | undefined {
    const key = familyKey(family);
    let best: Entry | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const id of this.#order) {
      const entry = this.#byId.get(id);
      if (entry === undefined || entry.familyKey !== key) continue;
      if (!this.#covers(entry, codePoints)) continue;
      const distance = faceDistance(entry.font, query);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best?.font;
  }

  #byScript(
    script: WordScript | undefined,
    query: FontQuery,
    codePoints: readonly number[] | undefined,
  ): FontResource | undefined {
    if (script === undefined) return undefined;
    let best: Entry | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const id of this.#order) {
      const entry = this.#byId.get(id);
      if (entry === undefined) continue;
      if (entry.font.scripts?.includes(script) !== true) continue;
      if (!this.#covers(entry, codePoints)) continue;
      const distance = faceDistance(entry.font, query);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best?.font;
  }

  resolve(query: FontQuery, codePoints?: readonly number[]): FontResource | undefined {
    const primary = this.#bestInFamily(query.family, query, codePoints);
    if (primary !== undefined) return primary;

    for (const fallback of query.fallbacks ?? []) {
      const found = this.#bestInFamily(fallback, query, codePoints);
      if (found !== undefined) return found;
    }

    const byScript = this.#byScript(query.script, query, codePoints);
    if (byScript !== undefined) return byScript;

    let best: Entry | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const id of this.#order) {
      const entry = this.#byId.get(id);
      if (entry === undefined || !this.#covers(entry, codePoints)) continue;
      const distance = faceDistance(entry.font, query);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best?.font;
  }
}

/** A registry with nothing in it; register faces before laying anything out. */
export function createFontRegistry(fonts: readonly FontResource[] = []): FontRegistry {
  const registry = new InMemoryFontRegistry();
  for (const font of fonts) registry.register(font);
  return registry;
}

/** Like `resolve`, but throws `render/no-font` instead of returning `undefined`. */
export function resolveFontOrThrow(
  registry: FontRegistry,
  query: FontQuery,
  codePoints?: readonly number[],
): FontResource {
  const font = registry.resolve(query, codePoints);
  if (font === undefined) {
    throw new RenderError(
      "render/no-font",
      `no registered font can draw "${query.family}"${
        query.script === undefined ? "" : ` for ${query.script}`
      }; register the subset fonts before rendering`,
      { family: query.family, script: query.script, registered: registry.list().length },
    );
  }
  return font;
}

/** Exposed for the registry's own tests; not part of the public surface. */
export const __testing = { readCharacterMap, familyKey, faceDistance };
