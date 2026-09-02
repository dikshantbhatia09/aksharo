/**
 * Where a style's static preview PNG lives on this app's own origin.
 *
 * `GET /styles` answers `previewKey` as a bare filename (`"punch-pop.png"`),
 * not a URL — the file is not the API's to serve. `scripts/copy-render-assets.mjs`
 * copies every rendered preview from `@montaj/caption-styles/previews/` into
 * this app's own `public/style-previews/` at install/dev time (mirroring how
 * `canvaskit.wasm` and the subset fonts get here), so the same-origin path
 * below is always where one landed.
 */
export function stylePreviewUrl(previewKey: string): string {
  return `/style-previews/${previewKey}`;
}
