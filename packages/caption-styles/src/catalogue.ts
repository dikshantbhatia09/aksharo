/**
 * Which system styles a person can pick.
 *
 * The owner cut the catalogue to one template on 2026-09-25. The other system
 * styles still ship in `styles/` and still resolve by id, because existing
 * documents reference them (`vertical-clean` alone backed 119 live projects)
 * and removing a document would leave those projects with a caption style that
 * no longer exists. They are simply never offered: not in the editor's
 * Templates panel, the Studio styles page, the repurpose form, the public
 * gallery, or `GET /styles`.
 *
 * To offer a style again, add its id here. Browser-safe: no filesystem access.
 */
export const PICKABLE_STYLE_IDS: readonly string[] = ["punch-pop"];

/** The style a new project's captions start on; always one of the above. */
export const DEFAULT_PICKABLE_STYLE_ID = "punch-pop";

/** Whether a system style id is offered to people. */
export function isPickableStyle(id: string): boolean {
  return PICKABLE_STYLE_IDS.includes(id);
}
