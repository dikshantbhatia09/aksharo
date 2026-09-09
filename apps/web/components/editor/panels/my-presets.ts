/**
 * K01's "My Presets" — the client-local stand-in for `StylePicker.tsx`'s
 * never-wired "Save as template" button (`StylePicker.tsx:155-164`,
 * `editor-client.tsx` never passed `onSaveTemplate`).
 *
 * The wave README's golden-rule addendum is explicit: no new Prisma
 * migration, no new API route for this — a client-local fallback instead.
 * So a preset is a complete, ordinary `StyleDoc` (not a base-style-id-plus-
 * overrides draft `ops.ts`'s `stylePresetDraft` was originally shaped for,
 * back when this was going to be a `POST /workspaces/{id}/style-presets`
 * body): "serialize current StyleDoc → store" per the brief, so a saved
 * preset renders through the exact same `resolveStyle` → `layoutSegment` →
 * `animate` path a system style does, once the editor merges it into the
 * catalogue map alongside `SYSTEM_STYLE_MAP` — no special-casing anywhere
 * downstream of this module.
 *
 * Scoped **per project**, not per workspace: `projectId` is the only stable
 * identifier already available where this is wired in (`editor-client.tsx`),
 * and reaching into workspace context would be new plumbing this WP's file
 * boundary does not cover. Documented in REPORT.md.
 */

// The `/browser` subpath, not the barrel: this module runs in the browser
// (localStorage), and the barrel re-exports the fs-backed style registry.
import {
  STYLE_DOC_VERSION,
  StyleDocSchema,
  type StyleDoc,
} from "@montaj/caption-styles/browser";

const STORAGE_PREFIX = "montaj:my-presets:";

export function myPresetsStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

/** Lowercase kebab-case, `StyleIdSchema`'s own alphabet, never empty. */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "preset";
}

/** A stable-enough, collision-resistant id: system styles never start with `my-`. */
function presetId(name: string): string {
  const suffix = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const id = `my-${slugify(name)}-${suffix}`;
  // StyleIdSchema caps ids at 48 characters.
  return id.length <= 48 ? id : `${id.slice(0, 48 - suffix.length - 1)}-${suffix}`;
}

export interface BuildPresetResult {
  readonly ok: boolean;
  readonly doc?: StyleDoc;
  readonly error?: string;
}

/**
 * Turns the editor's current effective style into a standalone, saveable
 * `StyleDoc`: a fresh id and the user's name, the parity flags reset to the
 * schema's own conservative pre-gate defaults (this preset never went
 * through the A18a parity gate), everything else — typography, colours,
 * effects, `depth3d`, emphasis presets — carried over exactly as the canvas
 * shows it right now.
 *
 * Runs the result through `StyleDocSchema` rather than trusting the clone:
 * that is what enforces D64 (acceptance criterion 6) on a user-chosen name
 * for free, with the schema's own message, instead of a second denylist
 * check drifting out of sync with the one `StyleDocSchema` already runs.
 */
export function buildPresetDoc(name: string, base: StyleDoc): BuildPresetResult {
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return { ok: false, error: "Name your preset with at least two characters." };
  }
  const candidate: unknown = {
    ...base,
    id: presetId(trimmed),
    name: trimmed,
    version: STYLE_DOC_VERSION,
    assRenderable: false,
    assExportable: false,
    requiresLayoutMetrics: true,
    parityScore: undefined,
    previewKey: undefined,
  };
  const parsed = StyleDocSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That name is not allowed." };
  }
  return { ok: true, doc: parsed.data };
}

function readStorage(projectId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(myPresetsStorageKey(projectId));
  } catch {
    // Private mode, or storage disabled: no remembered presets, none is fine.
    return null;
  }
}

function writeStorage(projectId: string, docs: readonly StyleDoc[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(myPresetsStorageKey(projectId), JSON.stringify(docs));
  } catch {
    // Nothing to do — the preset simply is not remembered on this device.
  }
}

/** Every saved preset for this project, oldest first; a corrupt entry is dropped, not fatal. */
export function loadMyPresets(projectId: string): StyleDoc[] {
  const raw = readStorage(projectId);
  if (raw === null) return [];
  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    entries = parsed;
  } catch {
    return [];
  }
  const docs: StyleDoc[] = [];
  for (const entry of entries) {
    const result = StyleDocSchema.safeParse(entry);
    if (result.success) docs.push(result.data);
  }
  return docs;
}

/** Appends one preset and persists the result. */
export function saveMyPreset(projectId: string, doc: StyleDoc): StyleDoc[] {
  const next = [...loadMyPresets(projectId), doc];
  writeStorage(projectId, next);
  return next;
}

/** Removes one preset by id and persists the result. */
export function deleteMyPreset(projectId: string, id: string): StyleDoc[] {
  const next = loadMyPresets(projectId).filter((doc) => doc.id !== id);
  writeStorage(projectId, next);
  return next;
}
