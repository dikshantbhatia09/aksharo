/**
 * What the right-hand panels emit.
 *
 * Every control in the Style, Colors, Look and Anim tabs produces one `EdgOp`
 * (CONTRACTS §2), never a mutation: the panel is a pure function from "what the
 * user touched" to an op, and the editor's op queue does the rest. Keeping that
 * function here — out of React — is what lets it be tested without a DOM, and
 * what stops two panels inventing two shapes for the same change.
 *
 * Scope matters: a change made with the document selected writes
 * `styles.inline.doc`; a change made with a segment selected writes that
 * segment's own `overrides`.
 */

import type { EmphasisPreset, WordHighlightType } from "@montaj/caption-styles";

import type { SegmentPosition } from "../canvas/stage-geometry";

/** Client-generated op id; the editor swaps in a real ULID. */
export type OpId = string;

export interface SetStyleOp {
  readonly op: "SetStyle";
  readonly opId: OpId;
  readonly scope: "doc" | "segment";
  readonly segmentId?: string;
  readonly styleRef?: string;
  readonly overrides?: Record<string, unknown>;
}

export interface SetSegmentPositionOp {
  readonly op: "SetSegmentPosition";
  readonly opId: OpId;
  readonly segmentId: string;
  readonly position: SegmentPosition | null;
}

export interface SetEmphasisOp {
  readonly op: "SetEmphasis";
  readonly opId: OpId;
  readonly segmentId: string;
  readonly wordId: string;
  readonly presetId: string | null;
}

export type PanelOp = SetStyleOp | SetSegmentPositionOp | SetEmphasisOp;

/** Where a panel change applies. */
export type PanelScope =
  { readonly kind: "doc" } | { readonly kind: "segment"; readonly segmentId: string };

/** Injected so tests get stable ids and the app gets ULIDs. */
export type OpIdFactory = () => OpId;

let counter = 0;
const defaultOpId: OpIdFactory = () => `panel-${String((counter += 1))}`;

/** Picking a style from the picker. */
export function setStyleRef(
  scope: PanelScope,
  styleRef: string,
  newOpId: OpIdFactory = defaultOpId,
): SetStyleOp {
  return {
    op: "SetStyle",
    opId: newOpId(),
    scope: scope.kind,
    ...(scope.kind === "segment" ? { segmentId: scope.segmentId } : {}),
    styleRef,
  };
}

/**
 * Any control that changes one field of the StyleDoc. The path is dotted
 * (`"typography.sizePct"`) and is expanded into the nested partial the
 * `SetStyle` op carries, because `styles.inline.doc` is merged, not replaced.
 */
export function setStyleField(
  scope: PanelScope,
  path: string,
  value: unknown,
  newOpId: OpIdFactory = defaultOpId,
): SetStyleOp {
  return {
    op: "SetStyle",
    opId: newOpId(),
    scope: scope.kind,
    ...(scope.kind === "segment" ? { segmentId: scope.segmentId } : {}),
    overrides: expandPath(path, value),
  };
}

/** Several fields at once — a brand kit applying four colours, say. */
export function setStyleFields(
  scope: PanelScope,
  fields: Readonly<Record<string, unknown>>,
  newOpId: OpIdFactory = defaultOpId,
): SetStyleOp {
  let overrides: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    overrides = mergeDeep(overrides, expandPath(path, value));
  }
  return {
    op: "SetStyle",
    opId: newOpId(),
    scope: scope.kind,
    ...(scope.kind === "segment" ? { segmentId: scope.segmentId } : {}),
    overrides,
  };
}

/** Dropping the caption box after a drag. */
export function setSegmentPosition(
  segmentId: string,
  position: SegmentPosition | null,
  newOpId: OpIdFactory = defaultOpId,
): SetSegmentPositionOp {
  return { op: "SetSegmentPosition", opId: newOpId(), segmentId, position };
}

/** Applying or clearing an emphasis preset on one word. */
export function setEmphasis(
  segmentId: string,
  wordId: string,
  presetId: string | null,
  newOpId: OpIdFactory = defaultOpId,
): SetEmphasisOp {
  return { op: "SetEmphasis", opId: newOpId(), segmentId, wordId, presetId };
}

/** `"a.b.c"` + value → `{ a: { b: { c: value } } }`. */
export function expandPath(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".").filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("a style field path cannot be empty");
  const root: Record<string, unknown> = {};
  let node = root;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      node[part] = value;
      break;
    }
    const next: Record<string, unknown> = {};
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    node[part] = next;
    node = next;
  }
  return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const current = result[key];
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    result[key] =
      isPlainObject(value) && isPlainObject(current) ? mergeDeep(current, value) : value;
  }
  return result;
}

/**
 * The template a "Save as template" button posts to
 * `/workspaces/{id}/style-presets`. The panel builds it; the API client (A14)
 * sends it.
 */
export interface StylePresetDraft {
  readonly name: string;
  readonly baseStyleId: string;
  readonly overrides: Record<string, unknown>;
}

export function stylePresetDraft(
  name: string,
  baseStyleId: string,
  overrides: Record<string, unknown>,
): StylePresetDraft {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new Error("a template needs a name of at least two characters");
  return { name: trimmed, baseStyleId, overrides };
}

/**
 * K01's Effects-tab Glow toggle: sugar over `animation.wordHighlight.type`,
 * the same field the Anim tab's own "Word highlight" dropdown already
 * writes, so the two UI paths share one implementation with nothing to
 * duplicate or drift. Toggling on sets the type to `"glow"`; toggling off —
 * from glow or from any other highlight type — clears it to `"none"`, the
 * same "off" every other word-highlight type already shares.
 */
export function toggleWordHighlightGlow(current: WordHighlightType): WordHighlightType {
  return current === "glow" ? "none" : "glow";
}

/**
 * K01's Emphasis panel control: which `effect` the style's *default*
 * emphasis preset (`emphasisPresets[0]` — the entry the right-click
 * "Emphasise word" cycle in `SegmentCard.tsx`/`editor-client.tsx`'s
 * `onEmphasize` reads and applies) uses once a word carries it. This reuses
 * the exact array entry the cycle already keys off — the panel picks the
 * effect, the cycle picks whether the current word gets it — rather than
 * inventing a second "default emphasis" concept the schema has no field for.
 * A style with no emphasis presets has nothing to default, so the array
 * comes back unchanged; the panel disables the control in that case, the
 * same guard `onEmphasize` already has.
 */
export function withDefaultEmphasisEffect(
  presets: readonly EmphasisPreset[],
  effect: EmphasisPreset["effect"],
): EmphasisPreset[] {
  const [first, ...rest] = presets;
  if (first === undefined) return [...presets];
  return [{ ...first, effect }, ...rest];
}

/**
 * K05's Emphasis Font/Font Face/Styles group: the same "write one field of
 * `emphasisPresets[0]`" shape as `withDefaultEmphasisEffect`, generalised to
 * any of the preset's own fields (`fontFamily`, `weight`, `italic`,
 * `underline`) so the panel does not need one bespoke helper per control.
 */
export function withDefaultEmphasisField<K extends keyof EmphasisPreset>(
  presets: readonly EmphasisPreset[],
  key: K,
  value: EmphasisPreset[K],
): EmphasisPreset[] {
  const [first, ...rest] = presets;
  if (first === undefined) return [...presets];
  return [{ ...first, [key]: value }, ...rest];
}
