import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";

/**
 * The three UI faces of 08 §1, self-hosted by `next/font` so there is no
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

export const fontDisplay = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-bricolage",
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
