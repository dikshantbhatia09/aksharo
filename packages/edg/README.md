# @montaj/edg

EDG v2 types, Zod schemas, the `EdgOp` union, id helpers, fractional ordering and the
projection validator.

**Status:** schemas and helpers landed by A02; the ops engine, the segmenter, snapshots
and `schemaVersion` migrations by A02b. The package is pure TypeScript with no database
access, so the API module (A12) and the browser client run the identical code.

The shapes are frozen in `docs/CONTRACTS.md` §2 and described in
`03-architecture/05-system-architecture.md` §4 (decisions D28, D29). Nothing outside this
package may redefine `Word`, `Segment`, `PassItem`, `EdgHot` or `EdgOp`.

> **Codename vs brand.** `montaj` is the engineering codename — it lives in the repo
> folder, the `@montaj/*` package scope and the schema URNs, and nowhere a user can see
> it. The brand is **Aksharo** and its strings live only in `packages/config/src/brand.ts`
> (CONTRACTS §0, decision D59). That is why the JSON Schema `$id`s are
> `urn:montaj:schema:edg-v2` and not the `https://montaj.ai/…` URL sketched in
> `03-architecture/07`: a codename must never appear in a domain.

## The model

```
EDG document
├─ hot state (edg_documents.doc, < 64 KB)
│  meta {edgId, projectId, revision, schemaVersion: 2, engineVersions?}
│  media[] · transcript{transcriptId, revision, language, scripts[], speakers[]}
│  canvas · styles · audio? · render?
├─ segments[]  (edg_segments rows)   ordered by a fractional `seq`
└─ passes[]    (edg_passes rows)
   └─ items[]  (edg_pass_items rows) one payload shape per `kind`
```

Words are not part of the document. They live in `transcript_chunks` — one row per
10-minute chunk per revision — and every segment addresses them by **stable word id**
`"<chunkIdx>:<n>"`, allocated once and never reused; deleting a word tombstones it
(`deleted: true`) instead of removing it. Times are absolute media milliseconds
throughout: `Word.s`/`Word.e` are on the same clock as `Segment.startMs`/`endMs`.

`EdgHot` is what the database stores; `EdgProjection` is the same document with the
segment and pass rows joined back in — the shape of `edg_snapshots.snapshot`, of
`fixtures/sample-project.json` and of `schemas/edg-v2.json`.

## Exports

| Subpath                                    | Contents                                                        |
| ------------------------------------------ | --------------------------------------------------------------- |
| `@montaj/edg`                              | everything below                                                |
| `@montaj/edg/schemas`                      | the Zod schemas and their inferred types                        |
| `@montaj/edg/seq`                          | fractional ordering (`seqBetween`, `compareSeqKeys`)            |
| `@montaj/edg/ops`                          | `EdgState`, `applyOps`, `rebaseOps`, snapshots, `EdgRepository` |
| `@montaj/edg/segmenter`                    | `segmentWords` and the per-script limits                        |
| `@montaj/edg/migrations`                   | `migrate` and the registered `v1` to `v2` step                  |
| `@montaj/edg/schemas/edg-v2.json`          | generated JSON Schema for the document                          |
| `@montaj/edg/schemas/edg-ops-v2.json`      | generated JSON Schema for the op union                          |
| `@montaj/edg/fixtures/sample-project.json` | the sample projection                                           |

The build emits both formats: CommonJS in `dist/` (the monorepo default, so NestJS and
the BullMQ workers can `require` it) and ES modules in `dist/esm/`, each with its own
declarations. `src/package-exports.test.ts` compiles a scratch consumer against every
subpath and loads both builds in a real Node process.

### Fractional ordering (`seq`)

`Segment.seq` is a **base-62 fraction written as a string** (`0-9A-Za-z`, ASCII order, no
trailing `0`), so `a < b` as strings means `a` comes first, and inserting between two
neighbours writes one row instead of renumbering the list.

```ts
import { seqBetween } from "@montaj/edg/seq";

const first = seqBetween(); //            "V"
const last = seqBetween(first); //        after first
const middle = seqBetween(first, last); // strictly between, for ever
```

Keys grow by at most one character per nested insertion and insertion is unbounded; both
properties are proved with fast-check in `src/seq.test.ts`.

### Ids

`newId()` mints monotonic ULIDs (CONTRACTS §0). `createUlidFactory({now, randomDigits})`
makes them deterministic in tests. `makeWordId(chunkIdx, n)` / `parseWordId(wid)` handle
word ids. Every id field in the schemas is validated as a ULID; style references
(`styleRef`, `defaultStyleId`) are not — a system style id such as `punch-pop` is a name,
not an id.

### Transcript index

```ts
const index = buildWordIndex(chunks); // Map<WordId, Word & {chunkIdx, offsetMs}>
wordsBetween(index, segment.startWordId, segment.endWordId); // inclusive, document order
```

The map is in **document order**, which is not numeric id order: `InsertWordAfter`
allocates a new `n` from the chunk's `nextWordSeq`, so a word inserted in the middle of a
chunk carries a higher number than its neighbours. `offsetMs` is the word's start relative
to its chunk.

### Validation

`validateProjection(projection, {wordIndex?})` returns an array of issues (empty means
valid) and `assertValidProjection` throws `ProjectionInvalidError`. It checks the schema
first, then: unique segment/pass/item ids, unique and ascending `seq`, `startMs ≤ endMs`
on segments and items, item↔pass ownership, keyframe references that agree, and — when a
`wordIndex` is supplied — that word references exist, run forwards, and that every
emphasis lies inside its own segment.

## JSON Schemas

`schemas/edg-v2.json` and `schemas/edg-ops-v2.json` are **generated** from the Zod schemas
(Zod 4 emits JSON Schema natively; `zod-to-json-schema` targets Zod 3 and is not used) and
committed. `pnpm --filter @montaj/edg build` regenerates them, and
`src/schemas/json-schema.test.ts` fails if the committed files are stale, so a schema
change cannot be merged without its documents. Ajv validates the fixture against
`edg-v2.json` in the same suite.

To regenerate on their own:

```sh
pnpm --filter @montaj/edg schemas:build
```

## Ops

`EdgOpSchema` is the discriminated union of the 17 ops in CONTRACTS §2 — id-addressed, so
no array index ever crosses the wire. Each op carries a client-minted `opId` (ULID) that
makes retries idempotent. `OpBatchRequestSchema` / `OpBatchResponseSchema` /
`OpConflictSchema` are the `POST /projects/{id}/edg/ops` envelopes, and `EdgOpsEventSchema`
is the realtime `edg.ops` payload.

`OpRejectionReasonSchema` is a **closed enum** — the engine never sends free text, and a
new reason means extending the enum (and the generated `edg-ops-v2.json`):

| Reason                  | Raised by     | Meaning                                                                                            |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `stale`                 | apply, rebase | the target id is tombstoned, or its word was deleted since the base revision                       |
| `conflict`              | rebase        | another writer edited the same word, or the same caption text; the API answers 409 with both texts |
| `invalid`               | apply         | the op payload is self-inconsistent (a `segment` scope with no `segmentId`, a repeated id)         |
| `invalid-range`         | apply         | a time or word range does not fit the document                                                     |
| `not-contiguous`        | apply         | `MergeSegments` named segments that are not neighbours                                             |
| `unknown-id`            | apply         | the segment, word, item or pass id is not in the document                                          |
| `invariant`             | apply         | applying would break a document invariant (id reuse, a word id below `nextWordSeq`)                |
| `rebased-away`          | rebase        | a later revision already wrote the same `(target, field)`                                          |
| `stale-after-resegment` | rebase        | a `Resegment` since the base revision replaced every segment id                                    |
| `forbidden`             | apply         | the writer may not submit this op — `MergePass` is worker-only                                     |
| `rate-limited`          | API           | the workspace write budget is spent (A12 raises it, never the engine)                              |

## The ops engine

```ts
import { applyOps, fromProjection, rebaseOps, toProjection } from "@montaj/edg/ops";

const state = fromProjection(projection, { chunks });
const { rebased, rejected } = rebaseOps(incoming, opsSince); // only when the client is behind
const result = applyOps(state, rebased, { source: "web", revision: 42 });
// result.state, result.applied[], result.rejected[{opId, reason}], result.skipped[]
```

`EdgState` is the document in memory: `hot`, `segments` by id with `segmentOrder` in `seq`
order, `passes` and `items` (items live **once**, and `toProjection` nests them back under
their pass), the transcript `words` index, the `chunks` bounds, the `tombstones` that make
an op against a dead id `stale`, and the `appliedOpIds` idempotency window — the last
10,000 accepted `opId`s, oldest evicted first.

`applyOps` is pure and **per-op atomic**: it copies what the batch touches, and each
handler validates everything before it writes anything, so one rejected op never rolls the
others back. An `opId` already inside the window is reported as applied without editing the
document again, which is what makes a retried batch safe. A **rejected** op is not
remembered: a retry judges it again against the document it now faces, so an op that was
`not-contiguous` against one revision can land against the next. That is deliberate — the
verdict belongs to the attempt, not to the id — and it is the reason a replayed batch is
only byte-for-byte idempotent when nothing in it was rejected. `toProjection` is **canonical** —
segments by `seq`, passes by `passId`, items by `(startMs, itemId)`, and empty optional
fields dropped — so two clients that applied the same commuting ops in a different order
serialise the same bytes.

Op semantics worth knowing, because CONTRACTS §2 fixes the shape but not the meaning:

- **SplitSegment** cuts _before_ `atWordId`: the head keeps the id and the `textOverrides`
  (they described a line that is now the head), the tail gets `newSegmentId` and a `seq`
  from `seqBetween`. Emphasis follows the words.
- **MergeSegments** joins neighbours only, keeps the first segment's style, position and
  `seq`, concatenates emphasis, and keeps a per-script override only when **every** merged
  segment had one. `newSegmentId` must be an id the document has never seen.
- **DeleteWord** tombstones the word; a segment whose range started or ended on it shrinks
  to the neighbouring live word, and one with no live words left is hidden rather than
  deleted. Emphasis pushed outside the new range goes with it.
- **InsertWordAfter** requires an id in the anchor's chunk, past every `n` the chunk has
  used (D28: ids are never reused), timed inside the gap between its neighbours.
- **SetWordTiming** retimes one word; it never recomputes segment bounds — those are the
  segment's own op (`SetSegmentBounds`) — but the new range must still leave
  `validateProjection` happy, so it is `invalid-range` when `s ≥ e`, when it overlaps the
  previous or next **live** word in the same chunk, when it crosses that chunk's own
  bounds, or when it would push the word outside the segment that currently contains it.
  A neighbour that has been deleted is ignored, exactly as `DeleteWord` intends.
- **Resegment** re-runs the segmenter over the live words, tombstones every previous
  segment id, re-homes emphasis by word id, and inherits style, position and `hidden` from
  the old segment that overlaps a new one by at least half its words.
- **SetStyle** with `scope: "doc"` sets `styles.defaultStyleId` and writes its `overrides`
  as the reserved inline document `styles.inline.doc`; with `scope: "segment"` it
  _replaces_ the segment's `styleRef`/`overrides` (an empty `overrides` clears them).
- **MergePass** is worker-only (`ctx.source === "worker"`, otherwise `forbidden`) and
  idempotent by `passId`.
- **EditWord** with `script: "translated"` is `invalid`: `Word.scripts` has only
  `roman`/`native`/`en` slots (CONTRACTS §2).

### The rebase transform table

`rebaseOps(incoming, opsSince)` runs before `applyOps` when the client's `baseRevision` is
behind. It reads **only ops** — never the document — so the browser can run it too. Rules
fire in this order:

| #   | `opsSince` contains            | Incoming op                                                                           | Outcome                                                                               |
| --- | ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `Resegment`                    | any segment-addressed op                                                              | `stale-after-resegment`                                                               |
| 1   | `Resegment`                    | word- or document-level op                                                            | kept                                                                                  |
| 2   | `DeleteWord{w}`                | any op naming `w`, including `SetWordTiming{w}`                                       | `stale`                                                                               |
| 3   | `EditWord{w}`                  | `EditWord{w}`                                                                         | `conflict` (409 carries both texts)                                                   |
| 3   | `EditWord{w}`                  | `EditWord{other}`                                                                     | kept                                                                                  |
| 4   | `MergeSegments{[A,B] -> AB}`   | `SetEmphasis`, `SetSegmentPosition`, `HideSegment`, `SetStyle`, `SplitSegment` on `A` | remapped to `AB` (chained merges are followed to the end)                             |
| 4   | `MergeSegments{[A,B] -> AB}`   | `SetSegmentText`, `SetSegmentBounds` on `A`                                           | `stale` — the merged line is a different line                                         |
| 4   | `MergeSegments{[A,B] -> AB}`   | `MergeSegments{[A,B]}`                                                                | `rebased-away` (nothing left to join)                                                 |
| 4   | `SplitSegment{A -> A,C}`       | `MergeSegments{[A, ...]}`                                                             | list grows to `[A, C, ...]`, so the ids are neighbours again                          |
| 5   | `SetSegmentText{s, script}`    | `SetSegmentText{s, script}`                                                           | `conflict` — caption text is never dropped silently                                   |
| 5   | any write to `(target, field)` | a write to the **same** field                                                         | `rebased-away` (last writer wins: the applied revision is later) — except text, above |
| 5   | any write to `(target, field)` | a write to another field, script, word or segment                                     | kept                                                                                  |
| 5   | `DecideItems`                  | `DecideItems` overlapping it                                                          | narrowed to the undecided items; `rebased-away` when none are left                    |
| 5   | `SetAudio`                     | `SetAudio` overlapping it                                                             | narrowed to the half nobody set; `rebased-away` when both are set                     |
| 6   | anything                       | an op still naming a dead id                                                          | `stale` — a rebased batch can never resurrect an id                                   |

Last writer wins is for the **scalar** fields — bounds, emphasis, position, hidden, style
and the document-level fields — where the loser is a setting the user can see and set
again. Caption text is the exception: a `SetSegmentText` that lost its
`(segment, script)` to a later revision comes back as a `conflict`, not
`rebased-away`, so the keystrokes the user just typed reach the client instead of
disappearing. The 409 carries both texts and the client resolves it, exactly as it does
for `EditWord`.

Fields are `text:<script>`, `bounds`, `emphasis:<wordId>`, `position`, `hidden` and `style`
per segment; `doc:style`, `doc:segments` (`Resegment`), `doc:audio:<key>` and
`doc:render:presets` per document; `item:<itemId>` and `pass:<passId>`. A `SplitSegment` in
`opsSince` counts as a write to its parent's `bounds`.

`SetWordTiming{wordId}` writes `timing:<wordId>` — a word-level field, so it is untouched
by rule 1 (`Resegment` survives it) and is subject only to rules 2 and 5: `stale` after a
`DeleteWord` of the same word, `rebased-away` when a later `SetWordTiming` on the same word
already landed (last write wins, same as bounds and the other scalar fields), and kept
otherwise.

### Segmentation

```ts
import { segmentWords, SCRIPT_LIMITS } from "@montaj/edg/segmenter";

const segments = segmentWords(liveWords, { maxLines: 2 }, { dropFillers: true });
```

One deterministic left-to-right pass, then one merge pass that absorbs runs shorter than
`minMs`, then one rebalancing pass that clears widows. A break only ever falls **between**
words:

- **hard** — the speaker changed;
- **forced** — one more word would need another line, run past `maxMs`, or push the
  reading speed past the script's ceiling;
- **preferred** — the previous word ended a sentence, or the pause before this word is at
  least `mergeGapMs` (150 ms); shorter gaps are never break points, which is what "merge
  gaps < 150 ms" in `09 §3` means. Preferred breaks wait until the caption has reached
  `minMs`, so the segmenter never manufactures a caption too short to read.

**Widows.** A forced break can leave the next caption holding a single word. Where the
caption before it can give up its last word and both halves still satisfy every limit
— including `minMs` for the shortened one — it does, so the pair reads as two lines
rather than as a line and a stray (A11). Only forced breaks are rebalanced: a speaker
change is a hard boundary, and a one-word caption after a full stop ("Bilkul.") is the
speaker's, not the arithmetic's.

Limits come from the script the words are written in, detected per word by Unicode block
(`09 §3`): Latin 32 characters a line at 20 CPS, Devanagari 24 at 15, Tamil 22 at 15,
anything else 26 at 15. **A "character" is a base code point** — combining marks do not
count — which is the character count for Latin and the grapheme-cluster count for Indic
scripts, and is what makes a 24-character Devanagari line comparable to a 32-character
Latin one.

`fixtures/segmenter-golden.json` holds three transcripts (Roman Hinglish, Devanagari Hindi,
Tamil) with the segments, wrapped lines, per-line character counts and reading speeds the
segmenter must produce. Regenerate it with `pnpm --filter @montaj/edg golden:build`, which
prints the table to read before committing.

### Snapshots, migrations and persistence

```ts
import { migrate } from "@montaj/edg/migrations";
import { replay, restore, snapshot } from "@montaj/edg/ops";

const stored = snapshot(state); // {schemaVersion: 2, projection, chunks?}
const reopened = restore(stored);
const { state: latest } = replay(stored, opsSinceTheSnapshot);
const carried = migrate(legacyDocument); // v1 to v2
```

A snapshot is the projection plus, optionally, the transcript chunks — the API loads those
from their own table, but an exported snapshot carries them so `restore` and `replay` can
resolve word ids without a database. Migrations transform **snapshots**, never op logs: a
revision's ops only ever replay against a snapshot of their own generation (D28). The
registered `v1` to `v2` step turns v1's flat word array and index-addressed
`wordRange: [i, j]` segments into transcript chunks with stable word ids, deriving the
chunk index from the cumulative `chunkSizes` v1 stored (or from 10-minute windows when it
did not). Segment texts and timings come through unchanged.

`EdgRepository` in `@montaj/edg/ops` is the **types-only** persistence surface A12
implements: `loadHot`, `loadSegments(cursor)`, `loadItems(passId)`, `appendRevision` —
which either returns the new revision or the `{latestRevision, opsSince}` conflict, never
the document — and `snapshotEvery = 100`.

## Packed keyframes (B19, codec unified in B19b)

`PassItem.payload.keyframes`/`keyframesRef` (CONTRACTS §2, keyframe payload rule
amended 2026-09-03 after B19b) carries a dense curve for a `zoom` or `reframe`
pass item: `encodeKeyframes`/`decodeKeyframes` (`src/passes/keyframes.ts`) are the
**one** encoder/decoder pair every producer (`worker-ai`) and every consumer (the
API, `render-core`, B20's UI) shares, over a `Keyframe = { tMs, zoom, cx, cy, ease:
"linear"|"inOut" }`, packed as the little-endian `MKF2` format below.

B19 shipped a second codec (`MKF1`, `src/keyframes.ts`, `{tMs, cx, cy, scale}`
rows with no per-row ease) alongside this one; B19b's ruling (CONTRACTS §2
amendment) deleted it — `MKF2` is the only wire format now, and every caller that
used to pack/unpack `MKF1` (`worker-ai`'s `reframe_zoom_pass.pack_keyframes`, the
API's completion handler) was moved onto `encodeKeyframes`/`decodeKeyframes`.

```ts
import { decodeKeyframes, encodeKeyframes } from "@montaj/edg";

const bytes = encodeKeyframes([
  { tMs: 0, zoom: 1.0, cx: 0.5, cy: 0.42, ease: "linear" },
  { tMs: 180, zoom: 1.2, cx: 0.5, cy: 0.42, ease: "inOut" },
]);
const frames = decodeKeyframes(bytes); // sorted by tMs, round-trips exactly
```

Byte layout, version 1:

```
offset  size  field
0       4     magic   ASCII "MKF2"
4       4     version uint32 LE, currently 1
8       4     count   uint32 LE, number of rows
12      20*n  rows    n x { tMs: f32, zoom: f32, cx: f32, cy: f32, ease: f32 }, all LE
```

`tMs` is milliseconds relative to the item's `startMs`; `cx`/`cy` are the subject
centre normalised 0..1; `zoom` is the zoom factor (>= 1); `ease` is packed as a
float (`0.0 = "linear"`, `1.0 = "inOut"`) so every row stays a flat run of
IEEE-754 binary32 values.

### Storage: inline vs. derived (B19b)

A packed payload <= 64 KiB rides inline as base64 on `PassItem.payload.keyframes`;
a larger one is uploaded by the worker to derived storage at
`ws/{workspaceId}/passes/{passId}/{itemId}.mkf` (CONTRACTS §6) and referenced by
`PassItem.payload.keyframesRef`. `ZoomPayloadSchema`/`ReframePayloadSchema`
(`src/schemas/pass.ts`) require exactly one of the two fields; a reader resolves
either form the same way `loadKeyframes` used to for `MKF1` — decode the inline
base64 directly, or fetch `keyframesRef` first.

## Fixtures

| File                               | What it is                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `fixtures/sample-project.json`     | 90 s, 3-speaker Hinglish projection: 12 segments, an autocut pass with 4 cut items, a reframe pass with 1 zoom item |
| `fixtures/sample-transcript.json`  | the matching `{manifest, chunks}` — 119 words in one chunk, with `roman`/`native` scripts                           |
| `fixtures/segmenter-golden.json`   | the three segmenter golden cases: Roman Hinglish, Devanagari Hindi, Tamil, with lines and line lengths              |
| `fixtures/legacy-v1-document.json` | a v1 EDG document (flat words, `wordRange` segments, `chunkSizes`) for the migration test                           |

They are hand-maintainable JSON, validated on every run by `src/schemas/schemas.test.ts`
(schema + invariants) and `src/schemas/json-schema.test.ts` (Ajv against the generated
JSON Schema).

## Layout

```
src/schemas/*.ts        Zod schemas, inferred types, JSON Schema emission
src/ids.ts              ULID factory, word ids
src/seq.ts              fractional ordering
src/transcript-index.ts word index and range queries
src/validate.ts         projection invariants
src/ops/                state, applyOps, rebaseOps, snapshots, repository types
src/segmenter/          script detection and segmentWords
src/migrations/         the migration registry and the v1 step
src/testing.ts          fixture builders for the tests (not shipped)
scripts/                JSON Schema generator, golden builder, ESM build marker
schemas/                generated JSON Schema documents (committed)
fixtures/               sample projection, transcript, goldens, v1 document (committed)
```

## Budgets come from `fitBudget`; readability caps are maxima

The 32/24/22 characters a line and two lines a caption in `09 §3` are
**readability caps** — what a viewer can read in the time the caption is up. They
are maxima, not targets, and they are not on their own a statement about what
fits on screen (decision D78).

What fits depends on the style's type size, the font's metrics for the script,
the caption box and the canvas: a 22-character Tamil line is around 37 code
points and roughly twice the width of 32 Latin characters, and a 9:16 frame is
1080 px wide where a 16:9 frame is 1920. `fitBudget` in `@montaj/render-core`
measures that and returns `min(readabilityCap, whatFits)`:

```ts
import { fitBudgetsByScript } from "@montaj/render-core";

const { maxCharsByScript, maxLines } = fitBudgetsByScript({
  style,
  canvas,
  registry,
  shaper,
});
const segments = segmentWords(words, { ...DEFAULT_SEGMENTER_PARAMS, maxCharsByScript, maxLines });
```

`SegmenterParams` therefore takes budgets three ways, most specific first:

| Field              | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `maxCharsByScript` | per script — what `fitBudget` produces, and what a mixed-script transcript needs |
| `maxChars`         | one number for every script                                                      |
| neither            | the readability table (`SCRIPT_LIMITS`)                                          |

The per-script form matters for Hinglish: the segmenter resolves the limit from
the script of the words in the run it is closing, so a Roman run and a Devanagari
run in the same transcript take different budgets.

A11 computes the budget at EDG initialisation from the project's aspect and
default style. A15 offers "Reflow captions" — a `Resegment` op — when a style
change moves it, because changing the style does not retroactively re-cut
captions.

## Scripts

| Script                                    | What it does                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @montaj/edg build`         | regenerate JSON Schemas, then `tsc` to CJS + ESM + types |
| `pnpm --filter @montaj/edg schemas:build` | regenerate `schemas/*.json` only                         |
| `pnpm --filter @montaj/edg golden:build`  | regenerate the segmenter golden fixture and print it     |
| `pnpm --filter @montaj/edg typecheck`     | type-check sources, tests and scripts                    |
| `pnpm --filter @montaj/edg lint`          | ESLint flat config from `@montaj/config/eslint`          |
| `pnpm --filter @montaj/edg test`          | Vitest (builds `dist/` first if it is missing)           |
| `pnpm --filter @montaj/edg test:coverage` | Vitest with the 90/85 gate from CONTRACTS §9             |
