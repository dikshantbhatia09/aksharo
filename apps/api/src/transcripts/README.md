# `transcripts` — words, and what happens to them (A11)

The producer that starts a transcription, the completion handler that turns a
worker's payload into a project you can edit, the post-processing that makes the
words readable, and the four ways to get them back out.

Design references: `docs/CONTRACTS.md` §2 (chunks, word ids), §3 (queues, the
completion callback), §4 (`CreditsFacade`); `03-architecture/09-ai-pipeline.md` §3
(post-processing, segmentation limits); `06-data-model.md` (`transcripts`,
`transcript_chunks`, `provider_submissions`, `memory_entries`);
`apps/api/src/edg/README.md` (`EdgService.initialise`); `packages/edg/README.md`
(the segmenter).

## The one rule

**The worker is stateless.** It never writes a row. Everything a transcription
produces arrives on one signed callback (`result.chunks`, already shaped like
`transcript_chunks`) and is turned into rows here, in one place, once. That is
what makes a retried ASR safe, a provider swap invisible to the database, and the
whole pipeline testable without a GPU.

## The path

```
POST /projects/{id}/transcribe
  ├─ project + primary media, probed?          → 409 transcript/media_not_ready
  ├─ quote from packages/config                  1 credit / media minute, ⌈0.1 min⌉
  ├─ mint transcriptId                           the completion writes to THIS row
  └─ JobsService.enqueue("ai.transcribe")        admission → row → reserve → BullMQ

POST /internal/jobs/{jobId}/complete            (HMAC, CONTRACTS §3, ≤ 32 MB)
  └─ TranscribeCompletionHandler
       ├─ parse + validate result.chunks         a worker is not trusted
       ├─ post-process                           `postprocess/`, below
       ├─ ONE transaction                        transcripts + transcript_chunks
       │                                         + provider_submissions + projects
       ├─ resolveBudgets → segmentWords          `edg/init/`, then A12's
       │  → EdgService.initialise                  createDocument: revision 1
       ├─ job event `transcript.postprocessed`   the corrections log
       └─ returns {actualTenths, data}           A08 settles and publishes
```

`JobsService` does the settling and the `job.completed` publish, as it does for
every queue — the handler only supplies the figure and the facts. That is why a
client that reacts to `job.completed` always finds the transcript already there:
the handler ran before the status flip.

### Why the handler runs before the status flip

A completion callback is **at-least-once**. If persistence ran after the
conditional `UPDATE`, the first transient database error would be permanent: the
job would already be `succeeded`, and the worker's retry would be answered
`already_completed` without the handler ever running again. Running first inverts
that — a throw leaves the job `running`, the callback answers 5xx, and the next
delivery re-drives everything. The price is that the handler must be idempotent,
which it is by construction:

| Write                  | Why a second run is safe                                      |
| ---------------------- | ------------------------------------------------------------- |
| `transcripts`          | `upsert` on the **producer-minted** id in the job payload     |
| `transcript_chunks`    | the revision's chunks are deleted and rewritten, not appended |
| `provider_submissions` | the job's rows are deleted and rewritten                      |
| `edg_documents`        | `EdgService.initialise` is idempotent by project (A12)        |

### The transaction, and what is deliberately outside it

`TranscriptsRepository.persist` writes the transcript, its chunks and the provider
submissions in **one** transaction. `EdgService.initialise` is not in it: A12's
repository opens its own, and Prisma cannot hand an interactive transaction to a
second service. The order is the safe one — the transcript exists before anything
points at it — and both halves are idempotent, so a crash between them converges
on a retry. The reverse order would not.

## Post-processing (`postprocess/`, `09 §3`)

Pure functions over words, with one impurity (`MemoryGlossarySource`) that is the
consent gate. They run in this order, and the order is the design:

| Step        | File             | What it does                                                                        |
| ----------- | ---------------- | ----------------------------------------------------------------------------------- |
| timings     | `pipeline.ts`    | ASR floats → **integer ms**, clamped into the chunk. Once, at the trust boundary.   |
| speakers    | `speakers.ts`    | `SPEAKER_07` → `s1`, numbered by first appearance **in the media**.                 |
| LID         | `lid.ts`         | Two signals — the provider's, and the script the words are in (D14).                |
| punctuation | `punctuation.ts` | Sentence boundaries from pauses ≥ 600 ms; capitals for Latin, danda for Devanagari. |
| numerals    | `numerals.ts`    | `ek lakh bees hazaar` → `1,20,000`; `rupaye pachaas` → `₹50`.                       |
| glossary    | `glossary.ts`    | Phonetic key + edit distance ≤ 2 against the workspace's terms.                     |
| fillers     | `fillers.ts`     | `fillers.json`, per language; contextual entries need a pause.                      |

The language verdict comes first because everything after it is
language-specific. Fillers come last so a word the glossary just corrected is
matched on its final spelling.

Every step returns `{words, corrections}` and the log is written to
`job_events` as `transcript.postprocessed` — the eval harness's input, and what
`GET /projects/{id}/transcript` returns as `postProcessing` so a user can see what
was changed on their behalf.

### Two-signal LID (D14)

A provider asked to transcribe Hinglish answers `hi` or `en` and both are half
right. What the caption pipeline needs is the **script**, because that decides the
line length, the reading speed and the font. So the verdict combines the
provider's answer with `dominantScript` — the segmenter's own detector, so the two
can never disagree about what a Devanagari word is — and Hindi in Roman letters
comes out as `hi-Latn`. Both signals are stored in `transcripts.detected_languages`:
a disagreement is information A10 and B09 both want.

### The consent gate

`GlossarySource` is an interface. `glossary.ts` never reads `memory_entries` and
never checks a consent record; `MemoryGlossarySource` does both, and the check
**is the query**:

```
kind IN (glossary, spelling) AND expires_at > now()
  AND consent.purpose = memory AND consent.granted AND consent.withdrawn_at IS NULL
```

There is no boolean a caller can forget to pass. A workspace without memory
consent simply yields no terms. B09 owns writing those entries; A11 owns reading
them into a transcription.

### Filler tagging, and the contextual case

`fillers.json` is data, not code, so a linguist can review a diff. Three kinds of
entry: **single** (`um`, `matlab`), **phrase** (`you know`, `kya bolte hain`,
matched across words so autocut can remove the lot), and **contextual** — `09 §3`
spells this out for `toh`, and the same is true of `like`, `so` and `haan`.
"toh main gaya" is a sentence; "toh… main gaya" is a stall. A contextual entry is
tagged only when a pause of ≥ 200 ms brackets it, which is the acoustic difference
between the two. A flag the worker already set is never cleared.

### Numerals, conservatively

Indian grouping (`1,20,000`, not `120,000`) is the visible half. The invisible
half is refusing to convert: `ek` is "one" and also half of `ek dum`, so a lone
number word is left alone, and a run that does not read as a descending number
(`ek do teen`) is refused whole rather than folded into `6`. The words a folded
run consumed are **tombstoned**, not deleted — their ids are spent for ever
(06 invariant 4).

## Caption budgets (D78)

`09 §3`'s 32 / 24 / 22 are a **readability** cap. A line also has to _fit_ the
style's type size on the project's canvas, so the budget is

```
maxChars = min(readability cap, fit cap, the workspace's own preference)
maxLines = min(2, …)
```

`src/edg/init/caption-budgets.ts` holds it, and the fit half really is
`fitBudget` from `@montaj/render-core` (A16d) — called, not stubbed. What it needs
is a `CaptionRenderContext` (a `FontRegistry` and a `Shaper`), and **A18b** is the
work package that registers the production subset faces. Until something binds
`CAPTION_RENDER_CONTEXT`, `fitCapFor` answers `undefined` and the budget is the
readability cap, reported as `source: "readability"`.

That is deliberate, not a placeholder: `averageAdvanceEm` raises `render/no-font`
rather than guessing, and a budget measured against a stand-in face would be a
wrong number wearing the word "measured". The call is covered now —
`transcript-init.test.ts` drives it through `createFixtureRenderer` and asserts
`min(readability, fit, preference)` — so binding a registry is the only change
left.

The canvas comes from `projects.aspect`, except that landscape footage overrides
an _untouched_ 9:16 default (the probe's dimensions win over a default nobody
chose; an aspect the user picked is never second-guessed). The budgets actually
used are recorded on `EdgHot.meta.engineVersions.captionBudgets`, so A15 can offer
"Reflow captions" when the style changes and know what the old budget was.

## Endpoints

| Method | Path                                       | Role   | Notes                                                               |
| ------ | ------------------------------------------ | ------ | ------------------------------------------------------------------- |
| `POST` | `/projects/{id}/transcribe`                | editor | `{languages[], hints[], diarise?, captions?}` → 202 with the quote. |
| `POST` | `/projects/{id}/transcript/retranscribe`   | editor | 409 `transcript/has_edits` unless `force: true`.                    |
| `GET`  | `/projects/{id}/transcript`                | viewer | Manifest + a page of chunks; cursor is the last `chunkIdx`.         |
| `GET`  | `/projects/{id}/transcript/export?format=` | viewer | `json` \| `srt` \| `vtt` \| `txt`, **source time**.                 |

`@Roles("editor")` admits editor, admin and owner: starting a transcription spends
the workspace's credits, so a viewer reads the result and does not commission it.
Every route wears `WorkspaceMemberGuard`, so a removal or a demotion bites on the
next request rather than at the end of the fifteen-minute token. A project in
another workspace is a **404**, not a 403 (THREAT-MODEL T4, T5).

### Source time, and what is A21's

An export's cues are where the words were spoken **in the uploaded media**. The
moment a project has cuts that stops being the finished video's clock, and mapping
through the cut list is A21's job (`@montaj/timemap`), which owns the output-time
variants of these same four formats. A silently wrong subtitle file is worse than
one the user knows is a transcript.

Cues come from the editing document's captions when it has them, so an export
reflects what the user edited; a project transcribed but never opened has its words
grouped by pause instead, because an export must not be empty just because the
editor has not run.

### Re-transcribing

A new transcription mints new word ids, and captions the user has retimed, split or
retyped are addressed **by** the old ones. So `retranscribe` is refused with
`transcript/has_edits` when `edg_documents.revision > 1`, and the error names the
way through (`{retryWith: {force: true}}`). With `force`, the new transcript is
written and `EdgService.initialise` finds the existing document and leaves it
alone — re-segmenting a live document is a `Resegment` op
(`POST /projects/{id}/edg/resegment`), not a creation.

## The `/internal` body limit

Express defaults to 100 kB. An `ai.transcribe` completion carries the whole
transcript: a 60-minute interview is roughly 9 000 words, each a
`{wid, s, e, t, c, sp, scripts}` object with two spellings — several megabytes, and
a three-hour recording is several times that. `internal-body-limit.ts` raises it to
**32 MB for `/internal` only** (a resource control: that surface needs
`INTERNAL_CALLBACK_SECRET`, whereas raising it globally would let any anonymous
request tie up 32 MB of heap).

Two details of the platform adapter decide its shape, and both are in the file's
own comments: it must run **before `app.init()`** so `body-parser` skips the
adapter's own 100 kB parser, and its handler must **not** be named `jsonParser` or
the adapter would skip registering the global one at all.

## Files

```
transcripts.controller.ts   the four routes; guards and roles
transcripts.service.ts      tenancy, the producer, the reads, the exports
transcripts.repository.ts   the one transaction; chunk paging
transcribe.handler.ts       what an `ai.transcribe` completion MEANS
transcripts.quote.ts        credits per media minute, and what to settle
transcript-export.ts        cues, and the four formats — source time only
transcripts.dto.ts          request schemas + OpenAPI response classes
transcripts.errors.ts       `transcript/*` codes and the page bounds
postprocess/                the `09 §3` pipeline, pure; `fillers.json` is data
```

Adjacent, and A11's: `src/jobs/completion-handlers.ts` (the registry every queue
owner registers into) and `src/edg/init/` (transcript facts → `EdgInitInput`,
caption budgets).

## Testing

```sh
pnpm --filter @montaj/api test src/transcripts     # unit: the pipeline, tables per script
pnpm --filter @montaj/api test src/edg/init        # unit: budgets and init input
pnpm --filter @montaj/api test test/transcripts    # e2e: needs Postgres + Redis
```

`test/transcripts.e2e-spec.ts` drives the shipped wiring against a real database
because every claim it makes is the database's behaviour: the transaction, the
`(transcript_id, revision, chunk_idx)` uniqueness, the EDG's compare-and-swap and
the 32 MB body. Its fixture is `packages/edg/fixtures/sample-transcript.json`
re-cut into **two** chunks — word ids are numbered per chunk, so a bug that
renumbers across a boundary is invisible until there are two.
