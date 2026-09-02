/**
 * `typography.textTransform`, in its own module because both the layout and
 * `styles/budget.ts` apply it — the budget has to measure the text the layout
 * will actually draw, and uppercase Latin is materially wider than lowercase.
 */

import { type StyleDoc } from "@montaj/caption-styles";

/** `textTransform` from the style, applied before anything is counted or shaped. */
export function applyTextTransform(
  text: string,
  transform: StyleDoc["typography"]["textTransform"],
): string {
  switch (transform) {
    case "uppercase":
      return text.toLocaleUpperCase();
    case "lowercase":
      return text.toLocaleLowerCase();
    case "capitalize":
      return text.replace(
        /(^|\s)(\S)/gu,
        (_match, lead: string, first: string) => lead + first.toLocaleUpperCase(),
      );
    default:
      return text;
  }
}
