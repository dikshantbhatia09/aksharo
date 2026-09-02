/**
 * `canvaskit-wasm` stands in for nothing here: the page loads the real wasm from
 * a script tag, so bundling emscripten's loader would only ship a second copy.
 * Aliased in by `build-bundle.mjs`, exactly as `@montaj/render-canvaskit` does.
 */
export default undefined;
