/**
 * `@montaj/fonts/node` — everything that needs a filesystem or the HarfBuzz
 * subsetter: validation, subsetting, the uploaded-font pipeline and the bundled
 * pack. Imported by `apps/api` and `apps/render`; never by the browser bundle.
 */

export {
  bundledPackDirectory,
  FontPackIntegrityError,
  loadPack,
  packLicencePath,
  packManifestPath,
  readPackManifest,
  registerManifestFonts,
} from "./pack.js";
export type { LoadedPack } from "./pack.js";
export { processFont, sha256, variationInstance } from "./pipeline.js";
export type { ProcessedFont, ProcessFontInput } from "./pipeline.js";
export {
  DROPPED_TABLES,
  FontSubsetError,
  REQUIRED_LAYOUT_FEATURES,
  subsetFace,
  subsetToSfnt,
  subsetToWoff2,
} from "./subset.js";
export type { SubsetOptions, SubsetPair } from "./subset.js";
export {
  detectContainer,
  embeddingVerdict,
  FontValidationError,
  isCollection,
  MAX_FONT_BYTES,
  MAX_GLYPHS,
  MAX_UPEM,
  MIN_UPEM,
  mayBeSubset,
  normaliseWeight,
  validateFont,
} from "./validate.js";
export type {
  FontContainer,
  FontValidation,
  FontValidationCode,
  ValidateOptions,
} from "./validate.js";

// The isomorphic surface, re-exported so a Node consumer needs one import.
export * from "./index.js";
