/**
 * `#RRGGBB(AA)` (StyleDoc's colour form) → ASS's `&HAABBGGRR&`.
 *
 * ASS colours are little-endian BGR with an *inverted* alpha byte: `00` is
 * opaque and `FF` is fully transparent, the opposite of a CSS/StyleDoc alpha
 * channel where higher means more opaque. Getting the inversion wrong is the
 * single most common libass authoring bug (a "correct" colour that renders
 * invisible), so it is isolated here and unit-tested exhaustively.
 */

const HEX6 = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const HEX8 = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–255, 255 = opaque. */
  readonly a: number;
}

/** Parses `#RRGGBB` or `#RRGGBBAA`; throws on anything else. */
export function parseHexColour(hex: string): Rgba {
  const eight = HEX8.exec(hex);
  if (eight !== null) {
    return {
      r: Number.parseInt(eight[1] as string, 16),
      g: Number.parseInt(eight[2] as string, 16),
      b: Number.parseInt(eight[3] as string, 16),
      a: Number.parseInt(eight[4] as string, 16),
    };
  }
  const six = HEX6.exec(hex);
  if (six !== null) {
    return {
      r: Number.parseInt(six[1] as string, 16),
      g: Number.parseInt(six[2] as string, 16),
      b: Number.parseInt(six[3] as string, 16),
      a: 255,
    };
  }
  throw new Error(`not a #RRGGBB or #RRGGBBAA colour: ${hex}`);
}

function byteHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
}

/** `#RRGGBB(AA)` → `&HAABBGGRR&`, alpha inverted per the ASS convention. */
export function toAssColour(hex: string): string {
  const { r, g, b, a } = parseHexColour(hex);
  const assAlpha = 255 - a;
  return `&H${byteHex(assAlpha)}${byteHex(b)}${byteHex(g)}${byteHex(r)}&`;
}

/** Just the `&HBBGGRR&` triple, for `\1c`/`\3c`-style override tags with no alpha. */
export function toAssColourNoAlpha(hex: string): string {
  const { r, g, b } = parseHexColour(hex);
  return `&H${byteHex(b)}${byteHex(g)}${byteHex(r)}&`;
}

/** The `\Nc` alpha-only tag value (`00` opaque .. `FF` transparent). */
export function toAssAlpha(hex: string): string {
  const { a } = parseHexColour(hex);
  return `&H${byteHex(255 - a)}&`;
}
