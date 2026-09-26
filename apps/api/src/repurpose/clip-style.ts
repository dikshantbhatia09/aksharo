import { isPickableStyle } from "@montaj/caption-styles";

/**
 * The caption style a clip's editing document should start on, from the
 * caption setup the run froze (`clip_variants.caption_config`, a copy of the
 * run's `config.caption`).
 *
 * Only a style a person can actually pick (`PICKABLE_STYLE_IDS`) is honoured.
 * A run can carry any id its catalogue offered when it was created — including
 * styles since retired from the picker, which the editor would then show with
 * no way to choose them again — so anything else is `undefined`, meaning "keep
 * the document's own default". Pure, and free of Nest, so the document builder
 * (`TranscriptDocumentService`) can call it without importing this module.
 */
export function clipDocumentStyle(captionConfig: unknown): string | undefined {
  if (typeof captionConfig !== "object" || captionConfig === null) return undefined;
  const styleId = (captionConfig as Record<string, unknown>)["styleId"];
  return typeof styleId === "string" && isPickableStyle(styleId) ? styleId : undefined;
}
