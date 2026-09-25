/**
 * `@montaj/caption-styles` — the StyleDoc v2 schema, the style naming rule (D64)
 * and the system style catalogue.
 *
 * A16 adds the remaining styles listed in `styles/registry.json`; A18a's parity
 * gate writes `assRenderable`, `assExportable`, `requiresLayoutMetrics` and
 * `parityScore` onto each document from an automated SSIM diff (D33).
 */
export * from "./schema.js";
export * from "./naming.js";
export * from "./catalogue.js";
export * from "./registry.js";
