# @montaj/fonts

The bundled open-licence font catalogue, font validation and subsetting, and the
`FontRegistry` loaders for the browser and the cloud renderer.

**Status:** implemented (A18b). Consumed by `apps/api` (manifests, upload,
sanitisation), `apps/render` (`RENDER_FONT_DIR`, the v1 pack this package
builds) and, through the loaders, `apps/web` (browser) and `apps/render`
(cloud).

This package owns the one thing every renderer has to agree on: which bytes a
face's id names. `@montaj/render-core`'s `FontRegistry` never reads a system
font (D33) — a host registers bytes it already has, and this package is where
those bytes come from, whichever host is asking.

## Two font stories, one manifest

| Origin      | Bytes come from                       | Who ships them                                    |
| ----------- | ------------------------------------- | ------------------------------------------------- |
| `bundled`   | `pack/`, committed to this repository | This package's build script, from `google/fonts`  |
| `workspace` | R2, under `ws/{workspaceId}/fonts/`   | A workspace's own upload, sanitised by `apps/api` |

Both are described by the same `FontManifest` (`{ v: 1, origin, fonts: [...] }`),
so one loader in the browser and one in the cloud renderer read either. The
bundled manifest has no `expiresAt` and its URLs are public and immutably
cached; a workspace manifest's URLs are signed and expire in five minutes.

## Using it

```ts
import { CATALOGUE, parseManifest, REQUIRED_SCRIPTS } from "@montaj/fonts";
import { loadPack, processFont, validateFont } from "@montaj/fonts/node";
import { loadFontsInBrowser } from "@montaj/fonts/browser";

// Cloud / Node: the committed pack, straight into a FontRegistry.
const { registry } = await loadPack();

// A workspace's upload, once its bytes are in hand:
const processed = await processFont({ bytes, claimedScripts: ["Deva"] });
// -> { validation, scripts, wordScripts, sfnt, woff2, sha256*, subset: true }

// Browser: fetch a manifest, decompress each WOFF2, register the sfnt.
const loaded = await loadFontsInBrowser({
  manifestUrl: "/fonts/manifest",
  prefer: "woff2",
  decompressWoff2: (bytes) => import("woff2-encoder/decompress").then((m) => m.default(bytes)),
});
```

Three entry points, isomorphic surface kept apart from the two platform-specific
ones:

| Import                  | Runs in | Gives you                                           |
| ----------------------- | ------- | --------------------------------------------------- |
| `@montaj/fonts`         | either  | manifest schema, scripts/script tags, catalogue     |
| `@montaj/fonts/node`    | Node    | validation, subsetting, the pipeline, the pack      |
| `@montaj/fonts/browser` | browser | the WOFF2 → `FontRegistry` loader, CSS `@font-face` |
| `@montaj/fonts/testing` | Node    | real pack bytes and crafted bad fonts, for tests    |

## The bundled catalogue

Open licence only (SIL OFL 1.1 or Apache-2.0), every licence text committed
beside the bytes in `pack/licences/`, every upstream file pinned to one commit
of `google/fonts` (`CATALOGUE_UPSTREAM_REF`) and re-checked against
`sources.lock.json` on every build. Nothing is fetched at runtime — not from
Google, not from a CDN — so the browser and the cloud can never disagree about
a typeface because a mirror served something different today (D33).

| Family                 | Weights                      | Scripts           | Licence |
| ---------------------- | ---------------------------- | ----------------- | ------- |
| Inter                  | 300, 400, 500, 600, 700, 900 | Latin             | OFL-1.1 |
| Montserrat             | 400, 600, 800, 900           | Latin             | OFL-1.1 |
| Poppins                | 400, 700, 800                | Latin, Devanagari | OFL-1.1 |
| Playfair Display       | 500, 600                     | Latin             | OFL-1.1 |
| Roboto Mono            | 500, 700                     | Latin             | OFL-1.1 |
| Anton                  | 400                          | Latin             | OFL-1.1 |
| Bricolage Grotesque    | 700, 800                     | Latin             | OFL-1.1 |
| JetBrains Mono         | 400, 700                     | Latin             | OFL-1.1 |
| Noto Sans              | 400, 700                     | Latin             | OFL-1.1 |
| Noto Sans Devanagari   | 400, 700                     | Devanagari, Latin | OFL-1.1 |
| Noto Sans Bengali      | 400, 700                     | Bengali           | OFL-1.1 |
| Noto Sans Gurmukhi     | 400, 700                     | Gurmukhi          | OFL-1.1 |
| Noto Sans Gujarati     | 400, 700                     | Gujarati          | OFL-1.1 |
| Noto Sans Oriya        | 400, 700                     | Odia              | OFL-1.1 |
| Noto Sans Tamil        | 400, 700                     | Tamil             | OFL-1.1 |
| Noto Sans Telugu       | 400, 700                     | Telugu            | OFL-1.1 |
| Noto Sans Kannada      | 400, 700                     | Kannada           | OFL-1.1 |
| Noto Sans Malayalam    | 400, 700                     | Malayalam         | OFL-1.1 |
| Noto Sans Ol Chiki     | 400, 700                     | Ol Chiki          | OFL-1.1 |
| Noto Sans Meetei Mayek | 400, 700                     | Meetei Mayek      | OFL-1.1 |
| Noto Sans Arabic       | 400, 700                     | Arabic            | OFL-1.1 |

`CATALOGUE` in `src/catalogue.ts` is the source of truth; `catalogue.test.ts`
checks it is open-licence only, that every script it declares is one the
catalogue knows, and that the 22 scheduled languages' scripts (`REQUIRED_SCRIPTS`,
which is `SCHEDULED_LANGUAGES`'s scripts plus Latin) are all covered by at least
one family. `pnpm --filter @montaj/fonts pack:report` prints the same table
against the pack actually on disk.

A variable source (`Inter[opsz,wght].ttf`, and so on) is **instanced** during
the pack build: every axis the source declares is pinned to a value before
`hb-subset` writes the static face, so nothing ships with variation axes and
the browser and the cloud cannot disagree about which instance a default
resolves to. `faceId`/`faceFileName` give every built face a stable id
(`noto-sans-devanagari-700`) and file name.

## Validation (THREAT-MODEL T7)

`validateFont(bytes, options)` in `@montaj/fonts/node` is the gate every
upload — bundled or custom — passes through before anything else looks at it.
Rules are cheapest-first, and each refusal carries a `fonts/*` code the API
hands straight to the client:

| Code                           | Refused because                                              |
| ------------------------------ | ------------------------------------------------------------ |
| `fonts/too_large`              | over `MAX_FONT_BYTES` (8 MiB)                                |
| `fonts/empty`                  | no bytes at all                                              |
| `fonts/unknown_format`         | not an sfnt, WOFF or WOFF2 signature                         |
| `fonts/unparsable`             | an OpenType parser (`fontkit`) could not read it             |
| `fonts/collection_unsupported` | a `.ttc` collection — which face did you mean?               |
| `fonts/no_outlines`            | bitmap-only, or declares zero glyphs                         |
| `fonts/embedding_restricted`   | `OS/2.fsType` forbids embedding, bitmap-only or view-only    |
| `fonts/too_many_glyphs`        | over `MAX_GLYPHS` (65,535) — no caption font needs that many |
| `fonts/script_not_covered`     | claims a script its character map does not cover (< 90%)     |
| `fonts/no_supported_script`    | covers none of the scripts this catalogue can subset for     |
| `fonts/bad_metrics`            | `unitsPerEm` outside `[16, 16384]`                           |

Two rules are worth calling out. **`fsType`** is the type designer's own
machine-readable licence statement in the `OS/2` table; a font marked
"no embedding", "bitmap embedding only" or "preview and print only" is refused
before the uploader's attestation is even recorded, because the file itself
says the uploader does not have the right the attestation would warrant.
**Script claims** are checked against the font's own character map —
`coverageRatio` — before subsetting, at a 90% threshold of the script's
_required_ repertoire (`REQUIRED_CODE_POINTS`, deliberately smaller than the
full Unicode block: a real shipped font legitimately omits a character or two).
A wrong claim would otherwise subset away everything and leave a caption that
silently falls back to a Noto face.

## Subsetting and WOFF2 (`@montaj/fonts/node`)

Both formats come from `hb-subset` (the same HarfBuzz that shapes captions,
compiled to wasm, via `subset-font`) run twice over the same character set —
never by compressing the first result — so a WOFF2 that disagreed with its
SFNT would have to disagree inside HarfBuzz itself:

- **SFNT** (`.ttf`) — what HarfBuzz shapes and what CanvasKit / `@napi-rs/canvas`
  rasterise. Neither backend reads WOFF2, so this is the format every renderer
  actually registers.
- **WOFF2** — about a third of the size, what the browser fetches and
  decompresses before registering the same bytes.

The subset always keeps `COMMON_RANGES` (space, ASCII punctuation, ZWNJ/ZWJ,
₹, €, curly quotes, …) alongside the requested scripts' ranges, because a
caption is never pure script. Two properties are tested directly:
subsetting **does not change shaping** — `subset.test.ts` shapes Devanagari,
Tamil and Latin samples through the real HarfBuzz shaper on the original and
the subset face and compares cluster structure, advances and offsets (glyph
_ids_ legitimately differ, since `hb-subset` renumbers them) — and a variable
font is **instanced, not carried** (`variationInstance` pins `wght` from the
font's own `OS/2.usWeightClass`, `wdth` to 100, `ital`/`slnt` to their
defaults).

## The manifest (`fonts.json`, `fontManifestSchema`)

```ts
{
  v: 1,
  origin: "bundled" | "workspace",
  generatedAt?: string,          // ISO-8601
  fonts: [{
    id: string,                  // "noto-sans-devanagari-700"
    family: string,
    weight: number,               // 100..900
    italic: boolean,
    file: string,                 // bare name, this directory only — the sfnt
    scripts: WordScript[],        // "latin" | "devanagari" | "tamil" | "other" — FontRegistry's hint
    scriptTags: ScriptTag[],      // ISO 15924 — "Deva", "Taml", … — the catalogue/coverage truth
    woff2?: string,               // bare name — the compressed twin, when there is one
    sizeBytes: number,
    woff2SizeBytes?: number,
    sha256: string,               // of `file`'s bytes
    licence?: "OFL-1.1" | "Apache-2.0",
    licenceFile?: string,         // inside pack/licences/
    upstream?: { repo, ref, path },
    url?: string,                 // filled in by the API — where the bytes are
    woff2Url?: string,
  }]
}
```

It is a **superset** of `apps/render`'s own `FontPackSchema`
(`apps/render/src/render/fonts.ts`): the same `{ v: 1, fonts: [{ id, family,
weight, italic, file, scripts }] }` in the same order, plus everything the API,
the browser loader and the licence record need. Zod strips unknown keys, so
`apps/render` parses a manifest written here without knowing about any of the
extra fields — one file, not two that can quietly disagree.

Two script vocabularies appear side by side and are deliberately not merged:
`scriptTags` (ISO 15924 — what the catalogue and coverage tests reason about)
and `scripts` (`WordScript` — `@montaj/edg`'s frozen segmenter alphabet that
`FontRegistry` actually resolves by). `toWordScript`/`toWordScripts` are the
only place they meet, and the mapping only ever narrows: anything that is not
Latin, Devanagari or Tamil becomes `"other"`, same as the segmenter.

## The 22 scheduled languages

`SCHEDULED_LANGUAGES` lists the Eighth Schedule languages `08 §1` promises,
each with its script; `REQUIRED_SCRIPTS` is those scripts plus Latin (for
English, romanised Hinglish and digits). `catalogue.test.ts` and the API's
`GET /styles/fonts/catalog` e2e both check the shipped families' own script
tags cover every one of them — against the built pack, not a claim in a table.

## The uploaded-font pipeline (`processFont`)

```
validate -> decide the scripts -> instance if variable -> subset (sfnt + woff2) -> checksum
```

A pure function of its bytes — no database, no object store, no queue — so
`apps/api`'s `FontsService.complete()` can run it inline and a future queue
consumer (should CONTRACTS §3 ever grow a font queue) runs the identical code
from a job payload. The declared scripts (the uploader's claim, already
checked by `validateFont`) win when given; otherwise the font's own covered
scripts are used, so an uploader who declares nothing still gets a usable
face. The **original** validated bytes are kept as well as the subset,
because the cloud renderer bakes whole faces into an image and never pays a
download, and because a font whose `fsType` forbids subsetting can still be
served, whole, as itself.

## Loaders

**`@montaj/fonts/node`** — `loadPack(options?)` reads a pack directory (default:
this package's own `pack/`) into a ready `FontRegistry`, verifying each face's
SHA-256 when `verify: true` (the pack test turns this on). `registerManifestFonts`
fetches a _fetched_ manifest's faces (bundled or a workspace's, the cloud
renderer's path for both) into an existing registry, warning rather than
throwing on one unreachable face — a project with one broken custom font
should still render its other thirty captions.

**`@montaj/fonts/browser`** — `loadFontsInBrowser(options)` fetches a manifest
(or takes an already-fetched one), resolves each face's URL, decompresses its
WOFF2 (the decompressor is **injected**, since `woff2-encoder` is ESM-only and
this package also builds to CommonJS) and registers the sfnt into a
`FontRegistry`. Falls back to a face's `.ttf` when no decompressor is given.
`installCssFontFaces` additionally installs manifest faces as CSS
`@font-face`s, for the font picker's own-typeface preview — nothing in the
render path needs this, since captions are drawn from `DrawCommand[]`, never
DOM text.

## The pack, and `RENDER_FONT_DIR`

`pack/` is committed: `fonts.json` plus a `.ttf` and a `.woff2` per face, and
`licences/*.txt`. `apps/render` reads this exact layout through
`RENDER_FONT_DIR` (`apps/render/src/render/fonts.ts` — its `FontPackSchema` is
the v1 subset of this package's own manifest, by design); the render image
bakes this directory in at build time. `apps/render/src/render/font-pack.test.ts`
loads the real committed pack and shapes Devanagari, Tamil and Latin samples,
asserting the fixture-fallback warning is **absent** — a production render
that quietly drew the three OFL test subsets instead of the real catalogue
would draw the right layout in the wrong typeface.

```
pack/
  fonts.json           # the manifest
  <face-id>.ttf         # sfnt — HarfBuzz, CanvasKit, @napi-rs/canvas
  <face-id>.woff2        # compressed twin — the browser
  licences/
    OFL-Inter.txt
    OFL-NotoSansDevanagari.txt
    ...
```

`apps/api`'s `BundledFontsController` serves this same directory: `GET
/fonts/manifest` returns the manifest with `url`/`woff2Url` filled in, and
`GET /fonts/pack/{file}` streams whichever file the manifest names — publicly
and immutably cached, because these bytes are OFL/Apache, identical for every
tenant, and a CSS `@font-face` cannot carry a bearer token.

## Rebuilding the pack

```
pnpm --filter @montaj/fonts pack:build                   # from sources.lock.json
pnpm --filter @montaj/fonts pack:build -- --update-lock   # re-pin after editing catalogue.ts
pnpm --filter @montaj/fonts pack:report                   # the table above, against pack/ on disk
```

`scripts/build-pack.ts` downloads each family's pinned upstream file (cached
under `.cache/`, gitignored), instances and subsets it, writes the `.ttf` and
`.woff2`, copies the licence text, and writes `pack/fonts.json`. Every built
face is re-validated with `validateFont` before it is trusted: a subset that
lost a script, or that still carries variation axes after instancing, fails
the build rather than reaching the manifest. `sources.lock.json` pins a
SHA-256 per upstream file, so "the same pack" is a checkable claim — a build
refuses to proceed if an upstream file moved, unless `--update-lock` is given.

## Layout

```
src/catalogue.ts    which families ship, at which weights, from where
src/scripts.ts      ISO 15924 tags, code-point ranges, the 22 scheduled languages
src/manifest.ts     the FontManifest schema, shared by the bundled pack and workspace uploads
src/validate.ts      validateFont() — the T7 gate
src/subset.ts        hb-subset wrappers: subsetToSfnt, subsetToWoff2, subsetFace
src/pipeline.ts       processFont() — the whole uploaded-font pipeline
src/pack.ts           bundledPackDirectory(), loadPack(), registerManifestFonts()
src/browser.ts        loadFontsInBrowser(), installCssFontFaces()
src/node.ts           re-exports the Node-only surface
src/testing.ts        real pack bytes and crafted bad fonts, for @montaj/fonts/testing
scripts/build-pack.ts  the pack build
pack/                 the committed bundled pack (fonts.json, faces, licences)
e2e/                  Playwright: a real WOFF2 fetched, decompressed and drawn in Chromium
```

## Scripts

| Script                                      | What it does                                          |
| ------------------------------------------- | ----------------------------------------------------- |
| `pnpm --filter @montaj/fonts build`         | `tsc` to `dist/` (CJS) and `dist/esm/` (ESM)          |
| `pnpm --filter @montaj/fonts typecheck`     | type-check including tests                            |
| `pnpm --filter @montaj/fonts lint`          | ESLint flat config from `@montaj/config`              |
| `pnpm --filter @montaj/fonts test`          | Vitest (coverage gate 90/85, CONTRACTS §9)            |
| `pnpm --filter @montaj/fonts test:coverage` | Vitest with the coverage report                       |
| `pnpm --filter @montaj/fonts test:e2e`      | Playwright — the browser loader against the real pack |
| `pnpm --filter @montaj/fonts pack:build`    | rebuild `pack/` from `sources.lock.json`              |
| `pnpm --filter @montaj/fonts pack:report`   | print the catalogue table against the pack on disk    |
