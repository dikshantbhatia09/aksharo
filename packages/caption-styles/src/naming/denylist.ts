/**
 * The style-name deny-list (decision D64).
 *
 * A TypeScript module and not the `denylist.json` it replaced. `naming.ts`
 * imported that file with `resolveJsonModule`, which is fine for the CommonJS
 * build but emits a bare `import ... from "./naming/denylist.json"` into
 * `dist/esm` — and real ESM requires `with { type: "json" }`. Node refused the
 * module, so **every rasteriser worker thread failed to start**:
 *
 *     RasterPoolError: a rasteriser worker could not start: Module
 *     ".../caption-styles/dist/esm/naming/denylist.json" needs an import
 *     attribute of "type: json"
 *
 * Cloud video export renders frames on those threads, so the whole render path
 * was down while the package's own tests passed (they run the CommonJS build).
 * The attribute cannot simply be added to the source: TypeScript rejects import
 * attributes when emitting CommonJS, and this package ships both.
 *
 * Keeping it as data in TypeScript costs nothing — it is still one file with no
 * logic in it, which a catalogue admin edits and a reviewer reads as a list —
 * and it works identically under CommonJS, ESM and every bundler.
 */

export interface Denylist {
  version: number;
  rule: string;
  maintainer: string;
  tokens: string[];
}

export const DENYLIST_DATA: Denylist = {
  version: 1,
  rule: "Styles describe the look, never a person, creator, platform or competitor product (decision D64). Tokens are matched case-insensitively against the id and the name: as a whole word always, and as a substring when the token is 5 characters or longer.",
  maintainer: "catalogue admin (see packages/caption-styles/README.md)",
  tokens: [
    "hormozi",
    "mrbeast",
    "beast",
    "kalakar",
    "captik",
    "pause",
    "submagic",
    "capcut",
    "tiktok",
    "instagram",
    "youtube",
    "reels",
    "shorts",
    "opusclip",
    "veed",
    "descript",
    "vizard",
    "kapwing",
    "zubtitle",
    "riverside",
    "canva",
    "adobe",
    "premiere",
    "davinci",
    "resolve",
    "snapchat",
    "facebook",
    "twitter",
    "threads",
    "linkedin",
    "whatsapp",
    "spotify",
    "netflix",
    "disney",
    "marvel",
    "apple",
    "google",
    "microsoft",
    "carryminati",
    "bhuvan",
    "gadzhi",
    "sidemen",
  ],
};
