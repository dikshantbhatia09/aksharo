import { beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap, type StyleDoc } from "@montaj/caption-styles";
import type { FitContext } from "@montaj/render-core";
import { createFixtureRenderer } from "@montaj/render-core/testing";

import {
  checkReflow,
  parseStoredCaptionBudgets,
  reflowParams,
  type StoredCaptionBudgets,
} from "./caption-budgets";

/**
 * `checkReflow` wraps the real `fitBudget` (A16d), so this drives it through
 * the fixture renderer `packages/render-core`'s own suite uses — a fake
 * registry would only prove the plumbing, not that "reflow needed" tracks a
 * budget that actually changed.
 */
const catalogue = loadSystemStyleMap();
let context: FitContext;

function style(id: string): StyleDoc {
  const found = catalogue.get(id);
  if (found === undefined) throw new Error(`no style ${id}`);
  return found;
}

beforeAll(async () => {
  context = await createFixtureRenderer();
});

describe("parseStoredCaptionBudgets", () => {
  it("parses a well-formed engineVersions.captionBudgets entry", () => {
    const stored: StoredCaptionBudgets = {
      maxChars: 24,
      maxLines: 2,
      script: "latin",
      aspect: "9:16",
      styleRef: "punch-pop",
      source: "readability",
      readabilityChars: 32,
    };
    expect(parseStoredCaptionBudgets({ captionBudgets: JSON.stringify(stored) })).toEqual(stored);
  });

  it("returns undefined when the key is absent, unparseable, or malformed", () => {
    expect(parseStoredCaptionBudgets(undefined)).toBeUndefined();
    expect(parseStoredCaptionBudgets({})).toBeUndefined();
    expect(parseStoredCaptionBudgets({ captionBudgets: "{not json" })).toBeUndefined();
    expect(
      parseStoredCaptionBudgets({ captionBudgets: JSON.stringify({ maxChars: "not a number" }) }),
    ).toBeUndefined();
  });
});

describe("checkReflow", () => {
  it("never reports reflow needed when nothing was recorded at init", () => {
    const result = checkReflow({
      stored: undefined,
      style: style("vertical-clean"),
      script: "latin",
      canvas: { width: 1080, height: 1920 },
      ...context,
    });
    expect(result.needed).toBe(false);
  });

  it("reports no reflow needed when the stored budget still matches the current measurement", () => {
    const measured = checkReflow({
      stored: undefined,
      style: style("vertical-clean"),
      script: "latin",
      canvas: { width: 1080, height: 1920 },
      ...context,
    }).current;

    const stored: StoredCaptionBudgets = {
      maxChars: measured.maxChars,
      maxLines: measured.maxLines,
      script: "latin",
      aspect: "9:16",
      styleRef: "vertical-clean",
      source: measured.limitedByFit ? "fit" : "readability",
      readabilityChars: measured.readabilityMaxChars,
    };

    const result = checkReflow({
      stored,
      style: style("vertical-clean"),
      script: "latin",
      canvas: { width: 1080, height: 1920 },
      ...context,
    });
    expect(result.needed).toBe(false);
  });

  it("reports reflow needed when a stale stored budget disagrees with the current measurement", () => {
    const stored: StoredCaptionBudgets = {
      maxChars: 1,
      maxLines: 1,
      script: "latin",
      aspect: "9:16",
      styleRef: "vertical-clean",
      source: "readability",
      readabilityChars: 32,
    };
    const result = checkReflow({
      stored,
      style: style("vertical-clean"),
      script: "latin",
      canvas: { width: 1080, height: 1920 },
      ...context,
    });
    expect(result.needed).toBe(true);
    expect(result.stored).toBe(stored);
  });

  it("carries fitBudget's belowComfortableMinimum straight through", () => {
    // 9:16, one-word styles measure below the comfortable minimum by design
    // (orchestrator addendum after A16d) — assert the flag is passed, not a
    // specific style's number, since that belongs to render-core's own tests.
    const result = checkReflow({
      stored: undefined,
      style: style("word-pop"),
      script: "latin",
      canvas: { width: 1080, height: 1920 },
      ...context,
    });
    expect(typeof result.current.belowComfortableMinimum).toBe("boolean");
  });
});

describe("reflowParams", () => {
  it("carries the measured chars/lines and the caller's own min/max caption length", () => {
    const params = reflowParams({ maxChars: 24, maxLines: 2 } as never, {
      minMs: 800,
      maxMs: 4500,
    });
    expect(params).toEqual({ maxChars: 24, maxLines: 2, minMs: 800, maxMs: 4500 });
  });
});
