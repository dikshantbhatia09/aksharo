/**
 * Lay the caption looks a preview answered with over a catalogue (2026-10-01).
 *
 * The public share viewer has no signed-in workspace, so it cannot read
 * `GET /styles` the way `useStyleCatalogue` does, and it used to draw with the
 * bundled system catalogue alone: a project or clip on a look its workspace
 * saved itself ("My templates") showed the default captions to everyone the
 * link was shared with, while the export drew the saved look. The preview now
 * carries the workspace looks its own document references
 * (`buildRenderPreview`'s `styles`, resolved the way an export resolves them),
 * and this adds them, keyed by the ref the document uses.
 *
 * Returns the base map itself (same identity) when there is nothing to add, so
 * a `CaptionStage` memoised on its `catalogue` does not re-register anything.
 */
import type { StyleDoc } from "@montaj/caption-styles";

export function mergeCatalogue(
  base: ReadonlyMap<string, StyleDoc>,
  styles: Readonly<Record<string, unknown>> | undefined,
): ReadonlyMap<string, StyleDoc> {
  if (styles === undefined) return base;
  const extra = Object.entries(styles).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      entry[1] !== null && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
  if (extra.length === 0) return base;
  return new Map([
    ...base,
    // The ref the document uses is the identity, whatever the blob says.
    ...extra.map(([ref, doc]) => [ref, { ...doc, id: ref } as unknown as StyleDoc] as const),
  ]);
}
