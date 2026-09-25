import { Anek_Latin, Inter, JetBrains_Mono } from "next/font/google";

/**
 * The three UI faces (docs/redesign/DESIGN.md), self-hosted by `next/font` so there is no
 * request to `fonts.googleapis.com` on a page load and no layout shift.
 *
 * The nine Indic Noto families are **not** here: they are ~1.5 MB nobody needs
 * on a first paint, so `loadIndicFont` in `@montaj/ui` asks for one the first
 * time a script actually appears (08 §1 — "loaded on demand").
 */

export const fontSans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * The display face: Anek Latin, from Ek Type, an Indian type foundry whose
 * Anek superfamily covers the Indic scripts this product captions. Variable in
 * weight and width; titles use it slightly condensed. Page titles and large
 * figures only — never a control or a paragraph.
 */
export const fontDisplay = Anek_Latin({
  subsets: ["latin"],
  weight: "variable",
  axes: ["wdth"],
  variable: "--font-anek",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

/** The class the `<html>` element carries so the CSS variables exist. */
export const fontVariables = `${fontSans.variable} ${fontDisplay.variable} ${fontMono.variable}`;
