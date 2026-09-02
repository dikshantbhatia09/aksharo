/**
 * The bundled catalogue: which families ship, at which weights, from where.
 *
 * **Open licence only.** Every family here is SIL OFL 1.1 or Apache-2.0, its
 * licence text is committed beside the bytes in `pack/licences/`, and the
 * upstream file is pinned to a commit of `google/fonts` so a rebuild produces
 * the same pack. Nothing is fetched at runtime — not from Google, not from a
 * CDN — because a caption whose typeface depends on the network is a caption
 * that renders differently in the browser and in the cloud (D33).
 *
 * The families are chosen by what the product actually asks for:
 *
 * - every `typography.fontFamily` in `packages/caption-styles/styles/*.json`,
 *   at every weight those styles name, or the styles resolve to a fallback and
 *   the parity goldens become a statement about the wrong typeface;
 * - every family in those styles' `fallbacks` arrays (`Noto Sans`, `Noto Sans
 *   Devanagari`, `Noto Sans Tamil`);
 * - the UI faces `08 §1` names (Inter, Bricolage Grotesque, JetBrains Mono);
 * - one Noto family per script of the 22 scheduled languages, at 400 and 700.
 *
 * Weight coverage is deliberately not exhaustive: `FontRegistry` picks the
 * closest available weight, so a Noto family at 400/700 answers a style asking
 * for 900 without shipping nine masters of twelve families.
 */

import { type ScriptTag } from "./scripts.js";

import type { BundledLicence } from "./manifest.js";

/** The `google/fonts` commit every upstream file is taken from. */
export const CATALOGUE_UPSTREAM_REF = "45b0855d499c093e4d1bd08926fec4e1a582e225";

export const CATALOGUE_UPSTREAM_REPO = "google/fonts";

/** One face to build: a weight, and the variation instance it comes from. */
export interface CatalogueFace {
  readonly weight: number;
  readonly italic?: boolean;
  /**
   * Upstream file, relative to the family directory. Omitted when the family
   * has a single variable source named by {@link CatalogueFamily.variableFile}.
   */
  readonly file?: string;
  /**
   * Axis values to pin when instancing a variable source. `hb-subset` writes a
   * static instance, so the shipped face has no axes left and the cloud and the
   * browser cannot disagree about a default.
   */
  readonly axes?: Readonly<Record<string, number>>;
}

export interface CatalogueFamily {
  readonly family: string;
  /** Directory under `ofl/` in `google/fonts`. */
  readonly directory: string;
  /** The variable source, when the family ships one. */
  readonly variableFile?: string;
  readonly licence: BundledLicence;
  /** File the licence text is committed to, inside `pack/licences/`. */
  readonly licenceFile: string;
  /** Path to the upstream licence, relative to the family directory. */
  readonly upstreamLicenceFile: string;
  /** Scripts this family is bundled for; also the subsetting instruction. */
  readonly scripts: readonly ScriptTag[];
  readonly faces: readonly CatalogueFace[];
  /** One line for the catalogue UI and the report. */
  readonly note: string;
}

const OFL = "OFL-1.1" as const;

/** Latin display and text families: what the 30 system styles are drawn in. */
const LATIN_FAMILIES: readonly CatalogueFamily[] = [
  {
    family: "Inter",
    directory: "inter",
    variableFile: "Inter[opsz,wght].ttf",
    licence: OFL,
    licenceFile: "OFL-Inter.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "UI and caption workhorse (08 §1); eleven system styles name it.",
    faces: [
      { weight: 300, axes: { wght: 300, opsz: 14 } },
      { weight: 400, axes: { wght: 400, opsz: 14 } },
      { weight: 500, axes: { wght: 500, opsz: 14 } },
      { weight: 600, axes: { wght: 600, opsz: 14 } },
      { weight: 700, axes: { wght: 700, opsz: 14 } },
      { weight: 900, axes: { wght: 900, opsz: 32 } },
    ],
  },
  {
    family: "Montserrat",
    directory: "montserrat",
    variableFile: "Montserrat[wght].ttf",
    licence: OFL,
    licenceFile: "OFL-Montserrat.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "neon-glow, outline-only, podcast-duo, prism-split, stroke-heavy.",
    faces: [
      { weight: 400, axes: { wght: 400 } },
      { weight: 600, axes: { wght: 600 } },
      { weight: 800, axes: { wght: 800 } },
      { weight: 900, axes: { wght: 900 } },
    ],
  },
  {
    family: "Poppins",
    directory: "poppins",
    licence: OFL,
    licenceFile: "OFL-Poppins.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn", "Deva"],
    note: "bubble-soft, duo-tone, gradient-sweep, karaoke-fill, spotlight-word, word-pop.",
    faces: [
      { weight: 400, file: "Poppins-Regular.ttf" },
      { weight: 700, file: "Poppins-Bold.ttf" },
      { weight: 800, file: "Poppins-ExtraBold.ttf" },
    ],
  },
  {
    family: "Playfair Display",
    directory: "playfairdisplay",
    variableFile: "PlayfairDisplay[wght].ttf",
    licence: OFL,
    licenceFile: "OFL-PlayfairDisplay.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "quote-frame and soft-serif.",
    faces: [
      { weight: 500, axes: { wght: 500 } },
      { weight: 600, axes: { wght: 600 } },
    ],
  },
  {
    family: "Roboto Mono",
    directory: "robotomono",
    variableFile: "RobotoMono[wght].ttf",
    licence: OFL,
    licenceFile: "OFL-RobotoMono.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "arcade-pixel, tape-retro, typewriter-mono.",
    faces: [
      { weight: 500, axes: { wght: 500 } },
      { weight: 700, axes: { wght: 700 } },
    ],
  },
  {
    family: "Anton",
    directory: "anton",
    licence: OFL,
    licenceFile: "OFL-Anton.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "bold-drop, glitch-shift, hype-bold, impact-shout. One weight upstream.",
    faces: [{ weight: 400, file: "Anton-Regular.ttf" }],
  },
  {
    family: "Bricolage Grotesque",
    directory: "bricolagegrotesque",
    variableFile: "BricolageGrotesque[opsz,wdth,wght].ttf",
    licence: OFL,
    licenceFile: "OFL-BricolageGrotesque.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "display and marketing headlines (08 §1).",
    faces: [
      { weight: 700, axes: { wght: 700, wdth: 100, opsz: 24 } },
      { weight: 800, axes: { wght: 800, wdth: 100, opsz: 48 } },
    ],
  },
  {
    family: "JetBrains Mono",
    directory: "jetbrainsmono",
    variableFile: "JetBrainsMono[wght].ttf",
    licence: OFL,
    licenceFile: "OFL-JetBrainsMono.txt",
    upstreamLicenceFile: "OFL.txt",
    scripts: ["Latn"],
    note: "timecodes and keyboard shortcuts (08 §1).",
    faces: [
      { weight: 400, axes: { wght: 400 } },
      { weight: 700, axes: { wght: 700 } },
    ],
  },
];

/** One Noto family per script, at 400 and 700 — the fallback chain's floor. */
interface NotoSpec {
  readonly family: string;
  readonly directory: string;
  readonly variableFile: string;
  readonly scripts: readonly ScriptTag[];
  readonly note: string;
}

const NOTO_SPECS: readonly NotoSpec[] = [
  {
    family: "Noto Sans",
    directory: "notosans",
    variableFile: "NotoSans[wdth,wght].ttf",
    scripts: ["Latn"],
    note: "Latin fallback in every system style.",
  },
  {
    family: "Noto Sans Devanagari",
    directory: "notosansdevanagari",
    variableFile: "NotoSansDevanagari[wdth,wght].ttf",
    scripts: ["Deva", "Latn"],
    note: "Hindi, Marathi, Nepali, Sanskrit, Konkani, Maithili, Dogri, Bodo.",
  },
  {
    family: "Noto Sans Bengali",
    directory: "notosansbengali",
    variableFile: "NotoSansBengali[wdth,wght].ttf",
    scripts: ["Beng"],
    note: "Bengali and Assamese.",
  },
  {
    family: "Noto Sans Gurmukhi",
    directory: "notosansgurmukhi",
    variableFile: "NotoSansGurmukhi[wdth,wght].ttf",
    scripts: ["Guru"],
    note: "Punjabi.",
  },
  {
    family: "Noto Sans Gujarati",
    directory: "notosansgujarati",
    variableFile: "NotoSansGujarati[wdth,wght].ttf",
    scripts: ["Gujr"],
    note: "Gujarati.",
  },
  {
    family: "Noto Sans Oriya",
    directory: "notosansoriya",
    variableFile: "NotoSansOriya[wdth,wght].ttf",
    scripts: ["Orya"],
    note: "Odia.",
  },
  {
    family: "Noto Sans Tamil",
    directory: "notosanstamil",
    variableFile: "NotoSansTamil[wdth,wght].ttf",
    scripts: ["Taml"],
    note: "Tamil.",
  },
  {
    family: "Noto Sans Telugu",
    directory: "notosanstelugu",
    variableFile: "NotoSansTelugu[wdth,wght].ttf",
    scripts: ["Telu"],
    note: "Telugu.",
  },
  {
    family: "Noto Sans Kannada",
    directory: "notosanskannada",
    variableFile: "NotoSansKannada[wdth,wght].ttf",
    scripts: ["Knda"],
    note: "Kannada.",
  },
  {
    family: "Noto Sans Malayalam",
    directory: "notosansmalayalam",
    variableFile: "NotoSansMalayalam[wdth,wght].ttf",
    scripts: ["Mlym"],
    note: "Malayalam.",
  },
  {
    family: "Noto Sans Ol Chiki",
    directory: "notosansolchiki",
    variableFile: "NotoSansOlChiki[wght].ttf",
    scripts: ["Olck"],
    note: "Santali.",
  },
  {
    family: "Noto Sans Meetei Mayek",
    directory: "notosansmeeteimayek",
    variableFile: "NotoSansMeeteiMayek[wght].ttf",
    scripts: ["Mtei"],
    note: "Manipuri (Meitei).",
  },
  {
    family: "Noto Sans Arabic",
    directory: "notosansarabic",
    variableFile: "NotoSansArabic[wdth,wght].ttf",
    scripts: ["Arab"],
    note: "Urdu, Sindhi and Kashmiri; Nastaliq is a later addition (see the README).",
  },
];

const NOTO_FAMILIES: readonly CatalogueFamily[] = NOTO_SPECS.map((spec) => {
  const axesAt = (weight: number): Record<string, number> =>
    spec.variableFile.includes("wdth") ? { wght: weight, wdth: 100 } : { wght: weight };
  return {
    family: spec.family,
    directory: spec.directory,
    variableFile: spec.variableFile,
    licence: OFL,
    licenceFile: `OFL-${spec.family.replace(/\s+/g, "")}.txt`,
    upstreamLicenceFile: "OFL.txt",
    scripts: spec.scripts,
    note: spec.note,
    faces: [
      { weight: 400, axes: axesAt(400) },
      { weight: 700, axes: axesAt(700) },
    ],
  } satisfies CatalogueFamily;
});

/** The whole bundled catalogue, in pack order. */
export const CATALOGUE: readonly CatalogueFamily[] = [...LATIN_FAMILIES, ...NOTO_FAMILIES];

/** A stable face id: `noto-sans-devanagari-700`, `inter-900-italic`. */
export function faceId(family: string, weight: number, italic = false): string {
  const slug = family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}-${String(weight)}${italic ? "-italic" : ""}`;
}

/** The file name a built face is written under, inside the pack directory. */
export function faceFileName(
  family: string,
  weight: number,
  italic: boolean,
  extension: "ttf" | "woff2",
): string {
  return `${faceId(family, weight, italic)}.${extension}`;
}

/** The raw upstream URL of one catalogue file, at the pinned commit. */
export function upstreamUrl(family: CatalogueFamily, file: string): string {
  const path = `ofl/${family.directory}/${file}`;
  return `https://raw.githubusercontent.com/${CATALOGUE_UPSTREAM_REPO}/${CATALOGUE_UPSTREAM_REF}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** The upstream path recorded in the manifest's `upstream.path`. */
export function upstreamPath(family: CatalogueFamily, file: string): string {
  return `ofl/${family.directory}/${file}`;
}

/** The source file one face is built from. */
export function sourceFileFor(family: CatalogueFamily, face: CatalogueFace): string {
  const file = face.file ?? family.variableFile;
  if (file === undefined) {
    throw new Error(`${family.family} names neither a face file nor a variable source`);
  }
  return file;
}

/** Every distinct upstream file the catalogue needs, de-duplicated. */
export function catalogueSources(): { family: CatalogueFamily; file: string }[] {
  const seen = new Set<string>();
  const sources: { family: CatalogueFamily; file: string }[] = [];
  for (const family of CATALOGUE) {
    for (const face of family.faces) {
      const file = sourceFileFor(family, face);
      const key = `${family.directory}/${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ family, file });
    }
  }
  return sources;
}

/** How many faces the built pack should contain. */
export function catalogueFaceCount(): number {
  return CATALOGUE.reduce((total, family) => total + family.faces.length, 0);
}
