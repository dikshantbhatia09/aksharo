# `edg` — the editing document (A12)

The hot document, its segments and passes, and the one write path every client
shares: `POST /projects/{id}/edg/ops` with a server-side rebase, a
compare-and-swap on `revision`, an append-only op log, snapshots every 100
revisions and a realtime echo.

Design references: `docs/CONTRACTS.md` §2 and §7, `packages/edg/README.md` (ops
semantics, the rebase transform table, `EdgRepository`), `03-architecture/05
§4` (D28, D29), `06-data-model.md` invariants 3–4.

## The one rule

**The engine decides what an op means; this module decides which rows change.**
`applyOps` and `rebaseOps` live in `@montaj/edg/ops` and are pure. The browser
applies a batch optimistically, a worker replays one over a snapshot, and this
module applies it inside a transaction — all three call the same functions, which
is the only reason the three agree about the document.

Nothing here interprets an op. If a verdict looks wrong, it is wrong in
`packages/edg`, and it is wrong in the editor too.

## Endpoints

| Method | Path                                              | Role   | Notes                                                            |
| ------ | ------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `GET`  | `/projects/{id}/edg`                              | viewer | Hot document, revision, first page of segments, passes, cursor.  |
| `GET`  | `/projects/{id}/edg/segments?cursor=&limit=`      | viewer | `seq` order, 500 a page (1000 max). Cursor is the last `seq`.    |
| `GET`  | `/projects/{id}/edg/passes`                       | viewer | Every pass with its items.                                       |
| `GET`  | `/projects/{id}/edg/passes/{passId}/items?state=` | viewer | One pass's proposals, optionally by review state.                |
| `GET`  | `/projects/{id}/edg/revisions?from=&limit=`       | viewer | The op log, oldest first, 200 a page.                            |
| `GET`  | `/projects/{id}/edg/snapshots`                    | viewer | Revisions a snapshot exists at, newest first.                    |
| `POST` | `/projects/{id}/edg/ops`                          | editor | `OpBatchRequest` → `OpBatchResponse`; 409 `edg/conflict`.        |
| `POST` | `/projects/{id}/edg/resegment`                    | editor | Server-minted `Resegment` op.                                    |
| `POST` | `/projects/{id}/edg/snapshots/{n}/restore`        | editor | Appends a revision replacing the state; 409 if it dangles.       |
| `POST` | `/internal/projects/{id}/edg/ops`                 | HMAC   | The worker surface: the only writer that may submit `MergePass`. |

`@Roles("editor")` admits editor, admin and owner; a viewer reads and is refused
a write with `common/forbidden`. A share-link reviewer holds no membership, so it
never reaches these routes at all — comments are B15's surface. A project in
another workspace is a **404**, not a 403: an id must not be testable for
existence (THREAT-MODEL T4, T5).

## The write transaction

```
BEGIN
  SELECT id, project_id, revision, doc FROM edg_documents WHERE id = $1 FOR UPDATE
  ├─ client_op_ids already recorded?  → replay that revision, COMMIT
  ├─ baseRevision > revision          → 409 edg/conflict
  ├─ more than 200 revisions behind,
  │  or a no-op revision in between   → 409 edg/too_stale
  ├─ baseRevision < revision          → load opsSince, rebaseOps(incoming, opsSince)
  │     └─ any `conflict` verdict     → 409 edg/conflict {latestRevision, opsSince, conflicts}
  ├─ load the WORKING SET (below)     — not the document
  ├─ applyOps(state, rebased, {source, revision: revision + 1})
  ├─ nothing landed?                  → 200 with every rejection; the revision does not move
  ├─ write the rows that changed      (segments, items, passes, chunks)
  ├─ UPDATE edg_documents SET revision = revision + 1, doc = $doc
  │    WHERE id = $1 AND revision = $observed RETURNING revision
  ├─ INSERT edg_revisions (ops as applied, client_op_ids, author, source)
  └─ revision % 100 == 0 → INSERT edg_snapshots
COMMIT
→ publish edg.ops to project:{id}
```

The row lock and the compare-and-swap do different jobs and both are kept. The
lock is what makes "read the revision, decide, write the revision" atomic, so
`edg_documents.revision` rises by exactly one per accepted batch under any amount
of concurrency (06 invariant 3). The CAS is the same invariant written into the
statement rather than into a convention: it still holds if a later caller forgets
the lock, or Postgres hands the row over after a failover.

The realtime publish happens **after** the commit, so no client is ever told
about a revision the database would still roll back.

### Rebase, or 409?

Both, and the split is the point.

A client that is behind is **rebased server-side and applied** — that is what
`OpBatchResponse.rebased` reports, and it is what makes the editor usable on a
flaky connection. Two things the server may not decide on the user's behalf come
back as a 409 instead:

- **A `conflict` from the rebase table.** Two writers typed different text into
  the same `(segment, script)`, or corrected the same word. Dropping either would
  throw away keystrokes, so the client resolves it. The body carries
  `{latestRevision, opsSince, conflicts}` — `opsSince` holds the winner's op (and
  therefore its text), `conflicts` names both strings explicitly.
- **`edg/too_stale`.** More than 200 revisions behind, or a revision with no ops
  in between. Replaying is not possible; reload.

The 409 never carries the document (D29) — only the ops since the client's base.

### A revision with no ops means "the state was replaced"

`edg_revisions.ops` is empty for exactly two things: the first revision A11
writes, and a snapshot restore. Neither is expressible as ops, so a client whose
`baseRevision` sits before one is told `edg/too_stale` rather than handed a log it
cannot replay. A normal batch never writes an empty op array — a batch where
everything was rejected creates no revision at all.

## The working set (partial-state application)

`appendRevision` must not read a 9,000-segment document to move one caption by
40 ms. `edg.working-set.ts` decides what a batch can touch; `edg.repository.ts`
turns that into queries. The neighbours are not a heuristic — they are exactly
what `@montaj/edg/ops` reaches for:

| The engine does this                                       | so the working set carries                        |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `SplitSegment` mints `seqBetween(seq, nextSeq)`            | the live segment after the last one addressed     |
| `MergeSegments` checks the ids are neighbours in the order | every live segment between the addressed ones     |
| `DeleteWord` shrinks the segments the word bounds          | segments whose `start/end_word_id` is that word   |
| `positionOf` ranks words in document order                 | the chunk of every word a loaded segment bounds   |
| `wordAfter`, `previousLiveWord` cross a chunk boundary     | one chunk either side of each chunk named         |
| an op against a dead id must be `stale`, not `unknown-id`  | the tombstoned rows among the ids addressed       |
| `Resegment` rebuilds every caption from every live word    | **the whole document** — there is no partial form |

Two consequences worth knowing:

- **Most edits read no words at all.** Setting a caption's text, style, position
  or `hidden` never asks the engine a question about a word, and a 10-minute
  chunk is the largest row the write path could read. `needsWords` is what keeps
  it out of the common case.
- **`Resegment` is the exception and says so.** It sets `wholeDocument` rather
  than guessing, and the repository loads every live segment and every chunk. A
  resegment of a 7.5-hour project is a heavy statement; it is also a deliberate,
  once-in-a-project action.

The state built from a working set is a **partial** `EdgState`: `toProjection` of
it is a partial projection and is only ever used to diff against the rows that
were read. A snapshot is built from a separate full read inside the same
transaction, which is the price of the cadence and is paid once every 100
revisions.

## Words

Word edits patch **only the `transcript_chunks` row the word lives in** — one
`UPDATE` of one `words` JSONB — and raise `next_word_seq` with it, because word
ids are allocated from it and never reused (06 invariant 4). `transcripts.
current_revision` moves only when a word actually changed, and the new value is
mirrored into `EdgHot.transcript.revision` in the same transaction.

Chunk rows are read newest-revision-first per `chunk_idx`, so a re-transcription
that writes a second generation beside the first is picked up without a migration.

A restore deliberately does **not** roll the transcript back: words live in their
own table with their own revision, and restoring captions must not un-correct a
spelling the user fixed afterwards.

That is also why a restore can fail. A snapshot old enough to predate a
`DeleteWord` still names that word, and writing it would leave a caption bounded
by something nothing can render. So before a single row is written, the
projection the restore would produce is run through `validateProjection` against
the transcript **as it now stands** — with a word index built from the **live**
words only, because a tombstoned word is as good as a missing one here. Any issue
refuses the whole restore with `409 edg/restore_invalid`, whose
`details.danglingWordIds` names the words and `details.issues` carries the
validator's findings. The whole transcript is read for that check: a restore is a
rare, deliberate, human action, which is exactly why it can afford what an op
batch cannot.

## Idempotency

`edg_revisions.client_op_ids` is the record; there is no second table to prune.
One indexed array-overlap query (`client_op_ids && $1`, against the GIN index in
`prisma/sql/0006-a12-edg.sql`) answers both cases a retry can be in:

- **Every id already recorded** — the client lost the response. The revision the
  first attempt produced is returned and the document is not touched.
- **Some ids already recorded** — the client retried with new ops appended. The
  recorded ids seed the engine's idempotency window, so `applyOps` reports them as
  applied without editing the document again and only the new ops land. Without
  this the repeat would run twice, which for a `SplitSegment` is not merely a
  double edit but an `invariant` rejection: the id it mints is already in use.

The response therefore lists a swallowed op under `applied` — it did land, once —
while the revision row and the realtime frame carry only the ops that actually
changed the document.

## Rate limiting

One token bucket per **workspace**: 20 batches of burst, refilling at 5 a second
(`EDG_OPS_BUCKET`). Not the shared `@RateLimit()` guard, which keys on the IP,
the user or a body field — one agency seat with twenty tabs open is one document
being edited, and the cost the limit protects is a row lock on that workspace's
documents.

Exhaustion is `429 common/rate_limited` with `Retry-After` and
`details.rejected` listing every op as `rate-limited` — the one rejection reason
in `packages/edg`'s closed enum that the API raises and the engine never does. The
limiter **fails open** on a Redis outage: losing it must not make the editor
read-only. The 500-op batch cap is the frozen `OpBatchRequestSchema`, so the
browser enforces the identical limit before it sends.

## `MergePass` is worker-only

`ctx.source === "worker"` or the engine answers `forbidden`, and "worker" cannot
be a claim in a user's token: a browser that could ask for it could land an
arbitrary pass with arbitrary licence snapshots in somebody's document. The only
route that submits ops as `worker` is `POST /internal/projects/{id}/edg/ops`,
behind the CONTRACTS §3 HMAC (`InternalSignatureGuard`, THREAT-MODEL T8). The
workspace budget is not charged there: a finished pass was admitted by A08's job
admission control long before it arrives, and throttling it would drop work the
user has paid for.

## `EdgService.initialise` — the A11 entry point

```ts
await edg.initialise(projectId, {
  transcriptId,
  language: "hi-Latn",
  scripts: ["roman", "native"],
  chunks, // as written to transcript_chunks
  speakers,
  segmenter: { maxLines: 2 }, // 09 §3 defaults otherwise
  dropFillers: true,
  author: null,
  source: "worker",
});
```

Runs `segmentWords` over the live words, writes the document, its segments,
revision 1 (no ops — nothing preceded it) and a snapshot at revision 1, so every
later restore has a floor to stand on. **Idempotent by project**: a re-run after a
retried transcription returns the existing document rather than a second one.
Re-segmenting a live document is a `Resegment` op, not a creation.

`apps/api/src/edg/init/` is A11's to create; `EdgService` and its input types are
exported from `src/edg/index.ts` for it.

## Schema additions

| Object                                                          | Why                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `edg_pass_items.keyframes_ref`                                  | `PassItem.keyframesRef` is frozen in CONTRACTS §2; the table only had the `keyframes` bytes column.      |
| `edg_segments (edg_id, start_word_id)`, `(edg_id, end_word_id)` | `DeleteWord` finds the segments a word bounds by word id, not by `seq`.                                  |
| `edg_revisions_client_op_ids_idx` (GIN)                         | The idempotency check is `client_op_ids && $1`, which `@@index` cannot express (`prisma/sql/README.md`). |

## Files

```
edg.controller.ts           the public surface; guards and roles
edg-internal.controller.ts  the signed worker surface (MergePass)
edg.service.ts              tenancy, the write budget, the realtime echo, initialise
edg.repository.ts           EdgRepository over Prisma: the transaction, CAS, snapshots, restore
edg.working-set.ts          what a batch can touch — pure, unit-tested on its own
edg.rows.ts                 row <-> domain mapping, the only place the two meet
edg.rate-limit.ts           the per-workspace op-batch bucket
edg.dto.ts                  frozen request schemas, OpenAPI response classes
edg.errors.ts               the domain's error codes and its four bounds
```

## Testing

```sh
pnpm --filter @montaj/api test src/edg          # unit: working set, mapping, DTOs, limiter
pnpm --filter @montaj/api test test/edg         # e2e: needs Docker (Postgres + Redis)
```

`test/edg.e2e-spec.ts` boots the shipped wiring against a real database because
every claim it makes is the database's behaviour: the `FOR UPDATE`, the
conditional `UPDATE`, the `text COLLATE "C"` ordering, the partial unique index on
a live `seq`, the GIN overlap and the Lua token bucket. Its `beforeAll` starts
testcontainers (or uses `TEST_DATABASE_URL` / `TEST_REDIS_URL`) and the suite
skips loudly when Docker is unavailable.

Measured on the compose Postgres, single-op batches, 40 samples:

| Document       | median  | p95     |
| -------------- | ------- | ------- |
| 12 segments    | 17.7 ms | 20.9 ms |
| 9,000 segments | 18.8 ms | 27.0 ms |

The 9,000-segment document is not slower than the small one, which is the whole
claim the working set makes: a batch costs what its ops cost, not what the
document weighs. The test therefore asserts the ratio as well as the 150 ms
budget — the absolute number moves with the machine, the ratio does not. (On a
laptop shared with a dozen other build agents the same run measured a 34.4 ms
median and a 137.9 ms p95: slower, still inside the budget, and still flat.)
