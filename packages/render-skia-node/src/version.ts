/**
 * The Skia build this package draws with, pinned exactly.
 *
 * `@napi-rs/canvas` ships a prebuilt Skia per platform. A minor bump can move an
 * anti-aliased edge by a quantisation step, which is a parity-gate failure with
 * no code change behind it — so the version is an `=` pin in `package.json` and
 * this constant is the copy a test compares against, exactly as
 * `@montaj/render-canvaskit` pins `canvaskit-wasm` at 0.42.0.
 */
export const NAPI_CANVAS_VERSION = "1.0.8";
