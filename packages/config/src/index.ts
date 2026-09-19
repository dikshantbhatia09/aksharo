/**
 * `@montaj/config` — shared build configuration and cross-cutting constants.
 *
 * Non-TypeScript presets are exported as subpaths and are NOT re-exported here:
 *   `@montaj/config/eslint`   flat ESLint config factory
 *   `@montaj/config/prettier` Prettier config
 *   `@montaj/config/vitest`   Vitest preset
 *   `@montaj/config/tsconfig.base.json` (also `.node.json`, `.react.json`)
 */

export * from "./brand.js";
export * from "./credits.js";
export * from "./engines.js";
export * from "./entitlements.js";
export * from "./env.js";
export * from "./launch-surfaces.js";
export * from "./media-formats.js";
