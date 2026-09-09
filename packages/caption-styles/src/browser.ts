/**
 * The browser-safe half of `@montaj/caption-styles`: the StyleDoc schema and
 * the D64 naming rule, with nothing that touches the filesystem.
 *
 * The package's own barrel (`index.ts`) re-exports `registry.ts`, which reads
 * the catalogue off disk (`node:fs`, `node:path`, `__dirname`). That is right
 * for the API, the workers and the renderer, and wrong for a bundle: `apps/web`
 * stubs the Node built-ins out for its client bundle, so pulling the barrel into
 * the browser drags in a module whose only purpose cannot work there.
 *
 * Splitting it also fixes a dev-mode failure that is otherwise unavoidable.
 * `next dev` appends React Refresh's `import.meta.webpackHot.accept()` footer to
 * every client module it compiles, and it decides what to skip by looking for a
 * literal `node_modules` segment in the path. pnpm resolves a workspace package
 * to its real location (`packages/caption-styles/...`), which has no such
 * segment, so the footer lands on this package's CommonJS output and webpack —
 * parsing it as CommonJS, because of `"type": "commonjs"` — rejects
 * `import.meta` outright. `transpilePackages` cannot help: its exclusion regex
 * needs the same `node_modules` segment. The way out is for the browser to
 * import real ESM, so the footer is legal. Hence the `./browser` subpath and the
 * `dist/esm` build behind it, exactly as `@montaj/fonts` already does for the
 * same reason.
 *
 * The web app gets its actual style documents from
 * `apps/web/components/editor/panels/system-styles.ts`, which imports each
 * `styles/*.json` explicitly, so nothing in the browser ever needed the
 * fs-backed loaders.
 */

export * from "./schema.js";
export * from "./naming.js";
