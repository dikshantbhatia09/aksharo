# @montaj/edg

EDG v2 types, Zod schemas, the `EdgOp` union, id helpers, fractional ordering and the
projection validator.

**Status:** schemas and helpers landed by A02. **Next:** A02b (rebase transform table,
compare-and-swap persistence, snapshots, `schemaVersion` migrations).

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

| Subpath                                    | Contents                                             |
| ------------------------------------------ | ---------------------------------------------------- |
| `@montaj/edg`                              | everything below                                     |
| `@montaj/edg/schemas`                      | the Zod schemas and their inferred types             |
| `@montaj/edg/seq`                          | fractional ordering (`seqBetween`, `compareSeqKeys`) |
| `@montaj/edg/schemas/edg-v2.json`          | generated JSON Schema for the document               |
| `@montaj/edg/schemas/edg-ops-v2.json`      | generated JSON Schema for the op union               |
| `@montaj/edg/fixtures/sample-project.json` | the sample projection                                |

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

`EdgOpSchema` is the discriminated union of the 16 ops in CONTRACTS §2 — id-addressed, so
no array index ever crosses the wire. Each op carries a client-minted `opId` (ULID) that
makes retries idempotent. `OpBatchRequestSchema` / `OpBatchResponseSchema` /
`OpConflictSchema` are the `POST /projects/{id}/edg/ops` envelopes, and `EdgOpsEventSchema`
is the realtime `edg.ops` payload.

`OpRejectionReasonSchema` is a closed enum (`stale`, `conflict`, `invalid`, `unknown-id`,
`forbidden`, `rate-limited`). A02b should extend that enum rather than send free text.

## Fixtures

| File                              | What it is                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `fixtures/sample-project.json`    | 90 s, 3-speaker Hinglish projection: 12 segments, an autocut pass with 4 cut items, a reframe pass with 1 zoom item |
| `fixtures/sample-transcript.json` | the matching `{manifest, chunks}` — 119 words in one chunk, with `roman`/`native` scripts                           |

They are hand-maintainable JSON, validated on every run by `src/schemas/schemas.test.ts`
(schema + invariants) and `src/schemas/json-schema.test.ts` (Ajv against the generated
JSON Schema).

## Layout

```
src/schemas/*.ts       Zod schemas, inferred types, JSON Schema emission
src/ids.ts             ULID factory, word ids
src/seq.ts             fractional ordering
src/transcript-index.ts word index and range queries
src/validate.ts        projection invariants
scripts/               JSON Schema generator, ESM build marker
schemas/               generated JSON Schema documents (committed)
fixtures/              sample projection and transcript (committed)
```

## Scripts

| Script                                    | What it does                                             |
| ----------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @montaj/edg build`         | regenerate JSON Schemas, then `tsc` to CJS + ESM + types |
| `pnpm --filter @montaj/edg schemas:build` | regenerate `schemas/*.json` only                         |
| `pnpm --filter @montaj/edg typecheck`     | type-check sources, tests and scripts                    |
| `pnpm --filter @montaj/edg lint`          | ESLint flat config from `@montaj/config/eslint`          |
| `pnpm --filter @montaj/edg test`          | Vitest (builds `dist/` first if it is missing)           |
| `pnpm --filter @montaj/edg test:coverage` | Vitest with the 90/85 gate from CONTRACTS §9             |
