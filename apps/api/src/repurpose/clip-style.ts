import { isPickableStyle, loadSystemStyleMap } from "@montaj/caption-styles";

/**
 * The caption style a clip's editing document should start on, from the
 * caption setup the run froze (`clip_variants.caption_config`, a copy of the
 * run's `config.caption`).
 *
 * A system style is honoured only while a person can actually pick it
 * (`PICKABLE_STYLE_IDS`): a run can carry any id its catalogue offered when it
 * was created, including styles since retired from the picker, which the
 * editor would then show with no way to choose them again - so such an id is
 * `undefined`, meaning "keep the document's own default".
 *
 * A look the workspace saved itself (2026-10-01, "My templates") is honoured:
 * it is not a system style (a workspace may not take a system style's key, so
 * any id that is not one is the workspace's), the run checked it existed when
 * it started, and the editor and the cloud render both resolve it by its key.
 * Without this every clip of a run started on a saved look was made in the
 * default style. Free of Nest, so the document builder
 * (`TranscriptDocumentService`) can call it without importing this module.
 */
export function clipDocumentStyle(captionConfig: unknown): string | undefined {
  if (typeof captionConfig !== "object" || captionConfig === null) return undefined;
  const styleId = (captionConfig as Record<string, unknown>)["styleId"];
  if (typeof styleId !== "string" || styleId.trim() === "") return undefined;
  if (isPickableStyle(styleId)) return styleId;
  return isSystemStyleId(styleId) ? undefined : styleId;
}

let systemIds: ReadonlySet<string> | undefined;

/** Whether `id` is one of the catalogue's system styles, offered or retired. */
function isSystemStyleId(id: string): boolean {
  systemIds ??= new Set(loadSystemStyleMap().keys());
  return systemIds.has(id);
}
