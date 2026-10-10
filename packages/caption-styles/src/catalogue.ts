/**
 * Which system styles a person can pick.
 *
 * The owner cut the catalogue to one template on 2026-09-25, and approved four
 * more on 2026-09-29, each a different look from Punch Pop that renders
 * Hinglish and Devanagari cleanly with the bundled font pack at 1080 x 1920:
 *
 * - `karaoke-fill` — the line fills as it is spoken, on a soft dark card;
 * - `hype-bold` — tall condensed capitals, three words at a time;
 * - `word-pop` — one big word at a time, in the middle of the frame;
 * - `vertical-clean` — plain, quiet type at the foot of the frame.
 *
 * The other system styles still ship in `styles/` and still resolve by id,
 * because existing documents reference them and removing a document would
 * leave those projects with a caption style that no longer exists. They are
 * simply never offered: not in the editor's Templates panel, the Studio styles
 * page, the repurpose form, the public gallery, or `GET /styles`. Two were
 * looked at for this list and left out for now: `box-block` (a line's box
 * covers the descenders of the line above) and `caption-card` (its one
 * emphasis preset paints the word in its own marker colour, so it vanishes).
 *
 * To offer a style again, add its id here; the first is listed first.
 * Browser-safe: no filesystem access.
 */
export const PICKABLE_STYLE_IDS: readonly string[] = [
  "punch-pop",
  "karaoke-fill",
  "hype-bold",
  "word-pop",
  "vertical-clean",
];

/** The style a new project's captions start on; always one of the above. */
export const DEFAULT_PICKABLE_STYLE_ID = "punch-pop";

/** Whether a system style id is offered to people. */
export function isPickableStyle(id: string): boolean {
  return PICKABLE_STYLE_IDS.includes(id);
}

export const VIRAL_PRESET_IDS = [
  "hormozi_neon",
  "editorial_ghost",
  "karaoke_cyan",
  "mrbeast_comic",
  "neon_pulse",
] as const;

export type ViralPresetId = (typeof VIRAL_PRESET_IDS)[number];

/** Whether an identifier is a registered popular viral style preset */
export function isViralPreset(id: string): boolean {
  return (VIRAL_PRESET_IDS as readonly string[]).includes(id);
}

export * from "./presets.js";
