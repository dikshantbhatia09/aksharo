/**
 * Ambient declarations for the three font tools, which ship no types.
 *
 * Only the surface this package uses is declared. That is deliberate: a fuller
 * hand-written type would drift from the library, whereas ten lines that the
 * compiler checks every call against cannot.
 */

declare module "fontkit" {
  export interface FontkitFsType {
    readonly noEmbedding?: boolean;
    readonly viewOnly?: boolean;
    readonly editable?: boolean;
    readonly noSubsetting?: boolean;
    readonly bitmapOnly?: boolean;
  }

  export interface FontkitFont {
    readonly familyName?: string;
    readonly subfamilyName?: string;
    readonly postscriptName?: string;
    readonly unitsPerEm?: number;
    readonly ascent?: number;
    readonly descent?: number;
    readonly lineGap?: number;
    readonly numGlyphs?: number;
    readonly characterSet?: readonly number[];
    readonly variationAxes?: Readonly<Record<string, unknown>>;
    /** Present only on a TrueType collection. */
    readonly fonts?: readonly unknown[];
    readonly "OS/2"?: { readonly fsType?: FontkitFsType; readonly usWeightClass?: number };
    readonly head?: { readonly macStyle?: { readonly italic?: boolean } };
  }

  export function create(buffer: Buffer, postscriptName?: string): FontkitFont;
}

declare module "subset-font" {
  export interface SubsetFontOptions {
    readonly targetFormat?: "truetype" | "woff" | "woff2" | "sfnt";
    readonly preserveNameIds?: readonly number[];
    readonly keepFeatures?: readonly string[];
    readonly variationAxes?: Readonly<Record<string, number | { min: number; max: number }>>;
    readonly noLayoutClosure?: boolean;
    readonly glyphNames?: boolean;
    readonly noHinting?: boolean;
    readonly dropTables?: readonly string[];
  }

  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>;
}

declare module "woff2-encoder/decompress" {
  export default function decompress(buffer: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
}

declare module "woff2-encoder" {
  export function compress(buffer: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
  export function decompress(buffer: ArrayBuffer | Uint8Array): Promise<Uint8Array>;
}
