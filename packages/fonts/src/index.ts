/**
 * `@montaj/fonts` — the font catalogue, the validation rules and the loaders.
 *
 * This entry point is **isomorphic**: schemas, the script and language tables,
 * and the catalogue metadata, with no filesystem and no wasm. The two halves
 * that need a platform live behind their own specifiers:
 *
 * | Import                  | Runs in | Gives you                                   |
 * | ----------------------- | ------- | ------------------------------------------- |
 * | `@montaj/fonts`         | either  | manifest schema, scripts, catalogue         |
 * | `@montaj/fonts/node`    | Node    | validation, subsetting, the bundled pack    |
 * | `@montaj/fonts/browser` | browser | the WOFF2 → `FontRegistry` loader           |
 */

export {
  CATALOGUE,
  CATALOGUE_UPSTREAM_REF,
  CATALOGUE_UPSTREAM_REPO,
  catalogueFaceCount,
  catalogueSources,
  faceFileName,
  faceId,
  sourceFileFor,
  upstreamPath,
  upstreamUrl,
} from "./catalogue.js";
export type { CatalogueFace, CatalogueFamily } from "./catalogue.js";
export {
  BUNDLED_LICENCES,
  fontFaceSchema,
  FontManifestError,
  fontManifestSchema,
  LICENCE_DIR,
  MANIFEST_FILE,
  manifestScriptTags,
  parseManifest,
  scriptTagSchema,
  summariseFamilies,
  wordScriptSchema,
} from "./manifest.js";
export type { BundledLicence, FamilySummary, FontFace, FontManifest } from "./manifest.js";
export {
  COMMON_RANGES,
  COVERAGE_THRESHOLD,
  coverageRatio,
  coveredScripts,
  expandRanges,
  isScriptTag,
  REQUIRED_CODE_POINTS,
  REQUIRED_SCRIPTS,
  requiredCodePoints,
  SCHEDULED_LANGUAGES,
  SCRIPT_NAMES,
  SCRIPT_RANGES,
  SCRIPT_SAMPLES,
  SCRIPT_TAGS,
  scriptsOfCodePoint,
  subsetCodePoints,
  subsetText,
  toWordScript,
  toWordScripts,
} from "./scripts.js";
export type { CodePointRange, ScheduledLanguage, ScriptTag } from "./scripts.js";
