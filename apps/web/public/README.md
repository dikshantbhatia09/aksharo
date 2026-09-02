# `public/` — renderer runtime assets

`canvaskit/canvaskit.wasm` and `fonts/*.ttf` are **copies**, written by
`pnpm --filter @montaj/web assets:render` (`scripts/copy-render-assets.mjs`).
They are not edited here.

They live on the app's own origin because a `.wasm` cannot be fetched
cross-origin under the app's CSP, and because the layout engine must shape with
exactly the fonts the export will use — a caption drawn with a substituted face
is a caption that moves when it is rendered in the cloud.

A18b replaces the three Noto subsets with the workspace's real subset faces
served from R2. The URLs the components fetch (`/canvaskit/`, `/fonts/`) do not
change.
