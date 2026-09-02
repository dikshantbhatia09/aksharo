/**
 * "Reflow captions for this style" (orchestrator addendum, decision D78).
 *
 * A11 records the budget it segmented with on `EdgHot.meta.engineVersions.
 * captionBudgets` (`apps/api/src/edg/init/caption-budgets.ts`'s `budgetsForMeta`
 * — read there, not modified: this module only parses what it wrote). When the
 * document's style or aspect changes to one whose `fitBudget` differs from that
 * recorded budget, the editor must offer — never silently perform — a
 * `Resegment` with the new per-script `maxChars`/`maxLines`, because
 * resegmenting invalidates manual edits (splits, merges, hidden captions).
 *
 * Also carries `fitBudget`'s `belowComfortableMinimum` straight through, for
 * the one-word-style hint the second addendum asks for.
 */
import type { StyleDoc } from "@montaj/caption-styles";
import { fitBudget } from "@montaj/render-core";
import type { FontRegistry, LineBudget, Shaper, WordScript } from "@montaj/render-core";

/** The shape `budgetsForMeta` in `apps/api/src/edg/init/caption-budgets.ts` writes. */
export interface StoredCaptionBudgets {
  readonly maxChars: number;
  readonly maxLines: number;
  readonly script: WordScript;
  readonly aspect: string;
  readonly styleRef: string;
  readonly source: "readability" | "fit";
  readonly readabilityChars: number;
  readonly fitChars?: number;
}

/** Reads `EdgHot.meta.engineVersions.captionBudgets`; `undefined` if absent or malformed. */
export function parseStoredCaptionBudgets(
  engineVersions: Readonly<Record<string, string>> | undefined,
): StoredCaptionBudgets | undefined {
  const raw = engineVersions?.["captionBudgets"];
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { maxChars?: unknown }).maxChars !== "number" ||
      typeof (parsed as { maxLines?: unknown }).maxLines !== "number"
    ) {
      return undefined;
    }
    return parsed as StoredCaptionBudgets;
  } catch {
    return undefined;
  }
}

export interface ReflowCheckInput {
  readonly stored: StoredCaptionBudgets | undefined;
  readonly style: StyleDoc;
  readonly script: WordScript;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
}

export interface ReflowCheck {
  /**
   * `true` only when a budget was recorded at initialisation *and* the current
   * style/canvas now measures differently — never `true` on first load with
   * nothing recorded, which would be a false "reflow available" the moment the
   * editor opens.
   */
  readonly needed: boolean;
  readonly current: LineBudget;
  readonly stored: StoredCaptionBudgets | undefined;
}

/** Compares the budget recorded at init against what the current style now measures. */
export function checkReflow(input: ReflowCheckInput): ReflowCheck {
  const current = fitBudget({
    style: input.style,
    script: input.script,
    canvas: input.canvas,
    registry: input.registry,
    shaper: input.shaper,
  });
  if (input.stored === undefined) return { needed: false, current, stored: undefined };
  const needed =
    current.maxChars !== input.stored.maxChars || current.maxLines !== input.stored.maxLines;
  return { needed, current, stored: input.stored };
}

/** The `Resegment` op parameters a "Reflow captions" click submits. */
export function reflowParams(
  current: LineBudget,
  fallback: { readonly minMs: number; readonly maxMs: number },
): { maxChars: number; maxLines: number; minMs: number; maxMs: number } {
  return {
    maxChars: current.maxChars,
    maxLines: current.maxLines,
    minMs: fallback.minMs,
    maxMs: fallback.maxMs,
  };
}
