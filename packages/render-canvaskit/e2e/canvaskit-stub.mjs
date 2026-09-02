// esbuild swaps `canvaskit-wasm` for this file when it bundles the executor for
// the browser: the page loads the real wasm from a <script> tag and hands the
// module in, so the dynamic import inside `loadCanvasKit` must never resolve to
// the emscripten loader (which would drag the whole wasm into the bundle).
export default function canvasKitStub() {
  throw new Error("the browser test supplies CanvasKit through a script tag, not through an import");
}
