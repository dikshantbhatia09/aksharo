# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Added

- **A12 — api: the EDG module (hot document, `/edg/ops` with server-side rebase
  and compare-and-swap, revisions, snapshots and restore, realtime `edg.ops`).**
  - `apps/api/src/edg/edg.repository.ts`: A02b's `EdgRepository` over Prisma. One
    batch is one transaction — `SELECT … FOR UPDATE` on the document row,
    `rebaseOps` against the ops since the client's base, `applyOps` on a partial
    state, row-level writes, then
    `UPDATE edg_documents SET revision = revision + 1 … WHERE revision = $observed
RETURNING revision`. The lock makes read-decide-write atomic; the CAS is the
    same invariant written into the statement rather than into a convention, so
    `edg_documents.revision` rises by exactly one per accepted batch (06
    invariant 3) even if a later caller forgets the lock.
  - **The working set** (`edg.working-set.ts`). A batch reads the rows its ops
    name plus exactly the neighbours `@montaj/edg/ops` reaches for — the segment
    after the last one addressed (a split mints a `seq` between them), everything
    between the addressed ones (a merge checks contiguity), the segments a deleted
    word bounds, and one transcript chunk either side of each one named. Most
    edits read no words at all: setting text, style, position or `hidden` never
    asks the engine about a word. Measured on the compose Postgres, a single-op
    batch is **median 33 ms, p95 67 ms on a 9,000-segment document** — no slower
    than on a twelve-segment one, which is the claim the design makes.
    `Resegment` is the one op with no bounded form and says so rather than
    guessing.
  - **Rebase, or 409.** A client that is behind is rebased server-side and
    applied (`OpBatchResponse.rebased`). Two things the server may not decide for
    the user come back as `409`: a `conflict` verdict — two writers typing
    different text into the same caption or correcting the same word — carrying
    `{latestRevision, opsSince, conflicts}` with **both texts** and never the
    document (D29); and `edg/too_stale` past 200 revisions or across a state
    replacement.
  - **Word edits touch one row.** `EditWord`, `DeleteWord` and `InsertWordAfter`
    patch only the `transcript_chunks` row the word lives in, raise its
    `next_word_seq` (ids are never reused, 06 invariant 4), and move
    `transcripts.current_revision` only when a word actually changed.
  - **Snapshots** every 100 revisions (`SNAPSHOT_EVERY`, D28) plus one at
    creation, stored without the transcript chunks — they live in their own
    table. `POST /edg/snapshots/{n}/restore` **appends** a revision that replaces
    the state; history is never rewritten, so restoring a later snapshot undoes
    it. A revision with no ops is the log's way of saying "the state was
    replaced", and anybody rebasing across one is told to reload.
  - **Idempotency** on `edg_revisions.client_op_ids` with a GIN index
    (`prisma/sql/0006-a12-edg.sql`): a retry after a dropped response returns the
    revision the first attempt produced instead of applying the edit twice.
  - **Rate limiting** per workspace — 20 batches of burst refilling at 5/s —
    because one seat with twenty tabs is one document being edited. Exhaustion is
    `429 common/rate_limited` whose `details.rejected` marks every op
    `rate-limited`, the one reason in `packages/edg`'s closed enum the API raises
    and the engine never does. Fails open on a Redis outage.
  - **`MergePass` is worker-only.** "worker" is never a claim in a user's token;
    the only route that submits ops as one is
    `POST /internal/projects/{id}/edg/ops`, behind the CONTRACTS §3 HMAC.
  - `EdgService.initialise(projectId, transcript)` — the entry point A11 calls
    once a transcript is segmented. Idempotent by project.
  - Realtime `edg.ops {revision, ops, source}` to `project:{id}` after the commit
    (CONTRACTS §7); the envelope's `at` is the server time.
  - Schema: `edg_pass_items.keyframes_ref` (CONTRACTS §2 freezes
    `PassItem.keyframesRef`; the table had only the bytes column) and
    `edg_segments (edg_id, start_word_id)` / `(edg_id, end_word_id)`, which is how
    a word delete finds the segments it bounds.

- **A16 — `@montaj/render-core`, `@montaj/render-canvaskit`, the 30 system styles and
  the editor's caption canvas.**
  - `@montaj/render-core` is implemented: `(StyleDoc, segment, words, time, canvas) →
DrawCommand[]`, pure TypeScript, HarfBuzz-wasm shaping (`harfbuzzjs` 1.6.1, pinned),
    a `FontRegistry` abstraction and no system fonts (D33). `layoutSegment` produces
    absolute geometry; `animate` turns it into commands as a pure function of time;
    `renderFrame` maps output time to source time through `@montaj/timemap` (D30),
    resolves each visible segment's effective style and draws them in `seq` order.
  - The `DrawCommand` union: `text` (shaped glyph ids with paired absolute positions
    and clusters), `rect`, `roundRect`, `path`, `image`, `group`, `transform`, `clip`,
    `shadow` and `blur` — the last with a `backdrop` flag for the styles that sample the
    video behind them. Fills and strokes take a solid or gradient `Paint`. Everything is
    JSON-serialisable and quantised, so a command list hashes stably and can be stored,
    diffed and shipped to a worker. `outlineTextCommands()` converts every glyph run to
    a path for a backend that cannot draw glyph ids, which is how A20's Canvas2D surface
    executes the same list.
  - Line breaking reproduces the segmenter's split rather than inventing one: the same
    greedy character wrap with the same counting rule (base code points, combining marks
    excluded). Only genuine metric overflow changes anything, and then the answer is
    shrink-to-fit; re-wrapping by width happens only at the shrink floor, and a break
    inside a word only when one word alone is too wide — always on a HarfBuzz cluster
    boundary, so a Devanagari matra or a Tamil conjunct is never cut in half.
  - Sizes stay relative: type, position and safe area off the canvas height, stroke,
    shadow, padding and radius off the font size, so one document renders identically at
    1080×1920 and at the 540p proxy. Document-level overrides are read from
    `styles.inline.doc` and beaten by a segment's own `overrides`.
  - `@montaj/render-canvaskit` executes the command list on Skia-WASM (`canvaskit-wasm`
    0.42.0, pinned): WebGL where available, CPU raster otherwise, both reported to the
    caller. Per-frame Skia objects live in an arena that is released however the frame
    ends, and a missing font or image is reported rather than thrown.
  - The 23 remaining styles in `styles/registry.json` are drawn, so all 30 validate,
    render and have a committed preview. Four need a capability StyleDoc v2 has no field
    for (two gradients, one backdrop blur, two raster passes); that ink lives in
    `render-core`'s `styles/capabilities.ts` keyed by style id rather than in a widened
    frozen schema.
  - `apps/web`: `StylePreviewCanvas` (a style drawn live, still or looping its
    three-second preview), `CaptionStage` (proxy video plus the CanvasKit overlay, safe
    zones, and a draggable caption box that emits exactly one `SetSegmentPosition` per
    drop, scrubbed with `requestVideoFrameCallback`), and the Style/Colors/Look/Anim
    right panel whose every control emits one `SetStyle` at the current scope.
    `/studio/styles` mounts the panel against the system catalogue.
  - Tests: golden `DrawCommand[]` hashes for 30 styles × 4 caption fixtures (Hinglish,
    Hindi, Tamil, English) × 3 instants plus full committed command lists; determinism
    tests; a chromium Playwright lane that executes a stored command list with CanvasKit
    and compares the encoded frame against the PNG Skia-in-Node drew from the same list,
    within D33's parity SLO. `render-core` sits at 99% lines / 93% branches against the
    90/85 gate, and a two-line 1080p frame lays out and draws in **0.11 ms** (p50)
    against a 2 ms target.
- **A25 — api: `notify` consumer, transactional email (SES/SMTP/dev outbox),
  English and Hindi templates, suppression, in-app notifications.**
  - `apps/api/src/notify`: a `MailProvider` port with three adapters chosen once
    at boot by `MAIL_PROVIDER` — `SesProvider` (AWS SDK v3 SESv2, credentials from
    the pod's IRSA role and region from `S3_REGION`, so there is still no mail key
    in CONTRACTS section 1), `SmtpProvider` (pooled nodemailer from `SMTP_URL`;
    Mailpit locally under the new compose profile `mail`), and `DevOutboxProvider`,
    which writes A04's Redis list at A04's key in A04's entry shape plus the
    rendered message and refuses to run in production. A misconfigured transport is
    a startup failure rather than a queue quietly filling with undeliverable jobs.
  - `NotifyService.enqueue({kind, to, locale, data, idempotencyKey})` — the brief's
    payload, carried as the `payload` of the frozen CONTRACTS section 3 envelope so
    a future out-of-process consumer parses the same shape. The idempotency key is
    the BullMQ job id, which is what makes a repeated enqueue a no-op; a message
    produced before a user belongs to anything uses the documented sentinel
    `workspaceId: "none"`, because the envelope requires a non-empty one.
    Enqueueing never throws for a delivery reason: a notification is a side effect
    of work the caller cares about, so a Redis hiccup is logged, exactly as
    `RealtimePublisher` already swallows one.
  - `NotifyConsumer`: one BullMQ `Worker` inside the API process behind
    `NOTIFY_WORKER_ENABLED` (default on; `0` for one-shot processes and test runs,
    the same lever `MONTAJ_SCHEDULER_DISABLED` is for the scheduler). Sending is a
    render and one HTTPS call, so a second deployable would be a rollout and an
    on-call surface for work the API is already sized for. Per job: suppression,
    then a ten-an-hour per-recipient bucket that the account-security kinds skip,
    then a delivery receipt checked before the render and written after the send —
    so the queue's five retries cannot deliver the same message twice. A malformed
    payload or a template missing a variable is an `UnrecoverableError`, because no
    amount of retrying fixes either.
  - Ten templates (`verify-email`, `magic-link`, `password-changed`,
    `device-approval`, `login-new-device`, `parental-waitlist`, `renewal-notice`,
    `low-credits`, `export-ready`, `share-comment`) as hand-written responsive HTML
    plus a real text part, from ICU MessageFormat strings in English and Hindi
    (08 section 6). **No remote images and therefore no tracking pixel**; values are
    escaped before ICU formats them, so a project called `<b>` is text and not
    markup; brand words arrive as `{brand}`/`{support}` from
    `packages/config/src/brand.ts` rather than being written into a string
    (CONTRACTS section 0). `List-Unsubscribe` (RFC 8058 one-click) only on
    `low-credits` and `share-comment` — everything else is transactional or, for
    the pre-debit `renewal-notice`, legally required.
  - `POST /internal/mail/events`: the SES bounce and complaint feed over SNS,
    authenticated by the **SNS message signature** rather than by
    `InternalSignatureGuard`, because SNS will not compute our HMAC. Canonical
    string, RSA-SHA1/SHA-256 verify, and a signing certificate fetched only from
    `https://sns.<region>.amazonaws.com/*.pem` (05 section 8's SSRF rule) — without
    that check the route would let anyone suppress any address they can name. SNS
    posts `text/plain`, so a middleware parses the body for that one route instead
    of widening the global parser. A `SubscriptionConfirmation` is verified and
    logged but never auto-confirmed: confirming is an outbound GET to a URL that
    arrived in a request.
  - Suppression: permanent for a hard bounce or any complaint, a fortnight for a
    transient one, released early by a later `Delivery`. The live set is in Redis
    keyed by SHA-256 of the address (a Redis dump should not be a mailing list) and
    every change — including each message _not_ sent — is an `audit_log` row with
    the address masked, because a cache is not an answer to "why did we stop
    mailing this customer?".
  - In-app notifications: a `notifications` table (`id`, `userId`, `workspaceId?`,
    `kind`, `data`, `readAt`, `createdAt`, both keys cascading so erasure takes the
    bell with it), `GET /me/notifications` and `POST /me/notifications/{id}/read`
    scoped to the user from the access token, and a realtime `notification.created`
    event on the workspace room. Rows carry no body text: wording is rendered per
    locale at read time, so switching language switches the bell.
  - A04's `AuthMailerService` is now a thin adapter onto `NotifyService.enqueue`
    instead of a logger. Its e2e suite completes real sign-up, verification and
    magic-link flows unchanged — delivery became asynchronous, so `auth-harness`
    drains the queue before reading the outbox rather than sleeping and hoping.
  - `MAIL_SNS_TOPIC_ARN` (optional): when set, `POST /internal/mail/events` refuses
    a correctly signed SNS message published to any other topic, and refuses it
    before fetching the certificate. The signature proves AWS published the
    message, not that we own the topic it came from, so an account can sign a
    perfectly valid bounce for any address from a topic of its own. Unset, any
    topic is accepted — a deployment that has not configured it is better off
    receiving bounces than silently discarding them.
  - Auth mail is written in the recipient's language: `users.locale` (default
    `en-IN`) reaches `AuthMailerService` from both call sites, and
    `test/notify-locale.e2e-spec.ts` drives a real sign-up to prove a `hi-IN`
    account receives the Hindi subject and greeting — a chain that runs from the
    sign-up request through the stored row, the notify job and the renderer, and
    that no single-layer test would catch breaking.
  - `tools/runbooks/mail-outbox.js` prints the development outbox.
  - 130 notify tests (template snapshots in both languages, provider selection and
    each adapter, SNS signature verification against a per-run self-signed
    certificate, suppression, retry and idempotency semantics, both bell endpoints)
    plus an HTTP suite for the `text/plain` webhook body. `apps/api` sits at 93.9%
    lines and 87.2% branches against the CONTRACTS section 9 gate of 75/70.

- **A09 — worker-ai: the BullMQ Python worker, provider interface, VAD and
  chunking, alignment and diarisation registries, evals.**
  - `apps/worker-ai/worker_ai/runtime.py`: one `bullmq.Worker` per `ai.*` queue.
    `ai.vad`, `ai.transcribe`, `ai.align` and `ai.diarise` are implemented;
    `ai.translate`, `ai.transliterate`, `ai.clean`, `ai.pass` and `ai.llm` are
    consumed and answered `worker/not_implemented` naming the work package that
    owns them, so a producer gets an error in seconds instead of a job that rots
    in Redis until the queue-wait sweeper finds it.
  - **Retry semantics against A08.** A job has two BullMQ attempts but one
    `attemptId`, so a failed completion posted on a non-final attempt would move
    the row to `failed` and make the retry invisible. The worker therefore posts a
    failed completion only on the final attempt (`finalAttempt: true`) or when the
    error is non-retryable (`error.retryable: false`) — the two flags
    `markDeadLetterIfFinal` reads — and re-raises either way.
  - `worker_ai/callbacks.py`: the signed progress and completion client of
    CONTRACTS section 3. The body is serialised once, signed as those exact bytes
    and posted unchanged; the worker signs with the primary
    `INTERNAL_CALLBACK_SECRET` only (`INTERNAL_CALLBACK_SECRET_NEXT` is the API's
    verification key during a roll). Bounded retries on transport, 5xx and 429;
    a 4xx is fatal; `applied: false` is reported as the success it is.
  - `worker_ai/vad.py` and `chunking.py`: decision **D14** — a full-file VAD pass,
    then nominal 10-minute chunks cut at the longest silence within ±30 s, never
    mid-region, no overlap. Silero v5 through onnxruntime (torch-free) when a model
    file is configured, and a deterministic energy backend otherwise, which is what
    CI and the property tests run on.
  - `worker_ai/providers/`: the `Provider` interface with a capability record, a
    cost estimate and a `ProviderSubmission` trail, plus a registry that reports
    _why_ an adapter is disabled. `MockProvider` (deterministic, Hinglish sample),
    `LocalWhisperProvider` (faster-whisper, optional `local-asr` extra) and
    `ServerlessWhisperProvider` (the D15 per-second GPU endpoint) ship; ElevenLabs
    Scribe v2, Sarvam Saaras v4 and AssemblyAI are shells carrying their
    capabilities and prices until A10.
  - `worker_ai/routing.yaml` + `routing.py`: the v2 routing table of `09 §1`
    (decision **D12**) as data, read-only, with a resolver that walks a lane and
    takes the first provider the deployment enables.
  - `worker_ai/alignment/` and `diarisation/`: the **D13** registries.
    `ProportionalAligner` distributes words by character length onto the VAD speech
    timeline and repairs monotonicity — the always-available rung; IndicWav2Vec,
    MMS and ElevenLabs FA are shells with their models and licences recorded.
    `NoopDiariser` labels every region `S1`; the pyannote community-1 shell records
    the model name and its CC-BY-4.0 licence.
  - `worker_ai/transcript.py`: stable `"<chunkIdx>:<n>"` word ids, chunk-local and
    dense, with the post-processing hook A11 replaces.
  - `worker_ai/control.py`: `GET /health`, `GET /providers` (every adapter, its
    enable flag and its reason, plus the routing table and both registries) and a
    `POST /evals/run` stub, on port 8091, pod-internal.
  - `worker_ai/evals/`: a fixture-manifest format, WER/CER over normalised text
    (Devanagari danda included), a runner and
    `python -m worker_ai.evals run --set fixtures/hinglish-mini --max-wer 0.15`,
    which is the gate `09 §8` needs to block a routing change on a regression.
  - `apps/worker-ai/Dockerfile` (CPU: ffmpeg, onnxruntime, faster-whisper and the
    Silero model baked in) and `Dockerfile.gpu`, a placeholder documenting the
    serverless-GPU image contract of D15.
  - `worker_ai/policies.py`: A08b's retry, stall and heartbeat table, mirrored from
    `apps/api/src/jobs/jobs.config.ts` and pinned by a parity test that parses the
    TypeScript. `attempts` and `backoff` reach the worker inside the job options,
    but `lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
    constructor options a worker has to read — and **the progress callback is the
    heartbeat**, so `JobContext.heartbeat()` reposts the last percentage every
    third of the lock and `ai.transcribe` beats while a chunk is inside a provider.
    Without it a ten-minute chunk on a two-minute lock would be declared stalled
    and handed to a second worker mid-transcription.
  - Tests: 321 unit and property tests with the CONTRACTS section 9 coverage gate,
    a callback suite verified against a server that implements the section 3
    signature, and `tests/test_integration.py` — a real BullMQ job from the API's
    own producer modules, consumed by a real worker, completing against the real
    API (`RUN_INTEGRATION=1`).

- **A05 — api: users, workspaces (tax profile), memberships, consent, privacy.**
  - `apps/api/src/users/`: `GET`/`PATCH /me` (name, avatar, locale, onboarding
    state, marketing opt-in, with a change to the opt-in also appending a
    `consent_records` row); `GET /me/data`, the DPDP access and portability right
    — a `dsr_requests` row of kind `export`, a JSON bundle of every row the
    account holds, and a single-use download link carrying 256 bits of entropy
    that expires in an hour; `DELETE /me`, the erasure right — a `dsr_requests`
    row of kind `erasure`, the account marked deleted, the address anonymised to
    an RFC 2606 `.invalid` mailbox and every session revoked in one transaction
    (the cascade over media and transcripts is B16). Both stamp `dueAt` 30 days
    out (DPDP Rule 14). The module also owns `AuditService`, the `audit_log` +
    `access_logs` writer every other A05 module uses.
  - `apps/api/src/workspaces/`: `GET`/`POST /workspaces`, `GET`/`PATCH`/`DELETE
/workspaces/{id}` (settings merged rather than replaced; a personal workspace
    that is the caller's only one cannot be deleted); `PUT
/workspaces/{id}/tax-profile` with the D41 rules — India requires a State code
    from the 36 live GST codes, an optional GSTIN is checked against its base-36
    check digit and must name that same State, currency is derived
    (`IN → INR`, else `USD`) and locked once a subscription exists, and confirming
    a profile stamps the new `billingCountryConfirmedAt` that B01 requires before a
    checkout; `GET /workspaces/{id}/entitlement`, the Free-plan stub cached in
    Redis for 60 seconds (B02 computes it for real); members
    (`GET`/`POST /workspaces/{id}/members`, `PATCH`/`DELETE .../{membershipId}`)
    with exactly one immutable owner, no granting a role above your own, and every
    session of a removed member revoked at once; and `/invitations` — accepted from
    the invitee's own verified address, so the id in the mail is a lookup key
    rather than a bearer secret.
  - `WorkspaceMemberGuard` on **every** `/workspaces/:id` route (THREAT-MODEL T4):
    the id in the path must be the token's `ws` claim, an active membership must
    still exist, and the principal's role is replaced with the one in the database
    so a demotion bites on the next request rather than at the end of the token's
    fifteen minutes. `test/workspace-guard.e2e-spec.ts` enumerates the shipped
    route table from the router and drives every `:id` route as a stranger, as a
    removed member and with no token, so a route added without the guard fails
    without anybody editing the test.
  - `apps/api/src/consents/`: `GET`/`POST /consents` over an append-only
    `consent_records` log (a refusal is a row, a withdrawal closes the grants it
    supersedes, and `users.marketingOptIn` / `analyticsConsentAt` /
    `memoryConsentAt` are mirrored in the same transaction); `reconsentRequired`
    reports an answer given against an older notice (D61, D62).
  - `apps/api/src/privacy/`: `GET /privacy/notice`, the itemised notice's version
    and purpose list, public because a person has to read it before creating an
    account; and `GET /admin/parental-waitlist`, which lives in A08b's
    `AdminModule` behind `AdminGuard` (`users.is_admin`) because the waiting list
    belongs to nobody's workspace and no membership could authorise reading it.
  - **Schema:** `workspaces.billing_country_confirmed_at` (the sign-up default is a
    guess, not a statement the customer made) and the `parental_waitlist` table
    (`sha256(address)`, jurisdiction, age bracket, `notifiedAt`), which
    `ParentalWaitlistService` drains A04's Redis hash into at boot. Migration
    `20260902030000_a05_billing_country_confirmed_and_parental_waitlist`.
  - No new environment variables and no new feature flags; `pnpm gen:client`
    regenerated `packages/api-client` (53 operations).
  - `apps/api/test/db-harness.ts`: the Docker probe waits 60 s rather than 20 s.
    Vitest collects the suite files in parallel, so every Docker-backed suite
    probes the daemon at once, and A05 took that from three suites to five; a
    timeout there does not fail a run, it silently skips every integration suite.
    A daemon that is genuinely absent still fails in milliseconds.

- **A08b — api: dead-letter queue, admin replay, retry/stall policy, job-event
  retention.**
  - `apps/api/prisma`: the `dlq` table (migration
    `20260902030000_a08b_dlq_replay`) — one row per attempt that exhausted its
    retry budget, carrying the queue, the payload, the last error, the attempt
    ordinal and the credit hold a replay has to reserve again — plus
    `jobs.dlq` / `dlq_reason` / `dlq_at` / `attempt_no` and `users.is_admin`. The
    migration **backfills** from the `job.dead_lettered` events A08 wrote when
    there was nowhere else to put them, so no dead letter is lost.
  - `apps/api/src/jobs/dlq.service.ts`: the dead-letter path. The copy is taken
    from the job row _before_ the completion update, so it remembers the hold, and
    it is idempotent on `(jobId, attemptId)` so an at-least-once callback writes
    one row. **Replay** claims the entry with a conditional update (two admins,
    one replay), reuses the same `jobs` row, mints a fresh `attemptId` and
    increments `attempt_no` — which makes the old attempt's late callback a
    `stale_attempt` no-op (THREAT-MODEL T8) — reserves credits again through the
    facade, and adds the BullMQ job last, so every earlier failure unwinds with
    nothing enqueued. **Discard** releases the hold and records a mandatory reason.
  - `apps/api/src/admin`: `AdminGuard`, which reads `users.is_admin` from the
    database on every request rather than from a token claim, so revoking an admin
    takes effect at once; and `GET /admin/dlq`, `/admin/dlq/stats`,
    `/admin/dlq/{id}`, `POST /admin/dlq/{id}/replay`, `/{id}/discard` and the bulk
    `/admin/dlq/replay` and `/admin/dlq/discard`, which **dry-run by default**.
    Every replay and discard writes an `audit_log` row (THREAT-MODEL T20); a
    non-admin is 403.
  - **Retry and stall policy per queue** (`jobs.config.ts`): attempts (media 3,
    ai 2, render 2, notify 5), exponential backoff **with jitter** — an
    un-jittered backoff retries a whole outage into the same dead provider at the
    same millisecond — and lock durations and stall intervals tuned per queue,
    with ten minutes on `ai.transcribe`, `ai.diarise` and `render.video`.
    `heartbeatIntervalMs()` is a third of the lock, and the heartbeat is the
    existing progress callback.
  - **Job-event retention** (D47): `jobs.event-retention`, nightly, deletes rows
    past their own `data.retainUntil` in batches, falling back to `at` for rows
    written before the marker existed. `dlq` rows are never purged.
  - **Metrics** and `GET /internal/metrics`, a Prometheus exposition rendered from
    an in-process registry that also mirrors into the OpenTelemetry metrics API.
    Names follow `infra/observability/METRICS.md` — `montaj_job_completed_total`,
    `montaj_queue_dlq_depth`, `montaj_queue_wait_duration_seconds`,
    `montaj_job_attempts`, `montaj_dlq_resolved_total` — with the A08b brief's
    `montaj_jobs_failed_total`, `montaj_dlq_depth` and `montaj_job_queue_wait_ms`
    emitted as aliases of the same data, because the shipped dashboards and the
    `MontajDlqNonEmpty` / `MontajDlqGrowing` rules query the METRICS.md names.
  - `tools/runbooks/dlq-replay.js`: `stats`, `list`, `show`, `replay` and
    `discard` against the admin API — not against Postgres, because the policy a
    replay has to honour lives in `DlqService`. `replay` and `discard` are dry runs
    unless `--confirm`, and refuse to run with no target.
    `docs/runbooks/dlq-replay.md` is rewritten around the real commands.
  - New optional environment variable `MONTAJ_METRICS_TOKEN` (non-contract): when
    set, `GET /internal/metrics` requires it as a bearer token.

- **A02b — `@montaj/edg` ops engine: apply, rebase, segmenter, snapshots, migrations.**
  - `@montaj/edg/ops`: `EdgState` (hot document, segments by id in `seq` order,
    passes and items, the transcript word index, tombstones and a 10,000-entry
    `opId` idempotency window) with `fromProjection`/`toProjection`, and
    `applyOps(state, ops, ctx)` implementing all 16 ops of CONTRACTS section 2.
    Pure TypeScript with no database access, so the API module (A12) and the
    browser client run the identical code; per-op atomic, so one rejected op never
    rolls back the rest of a batch; `toProjection` is canonical, so two clients
    that applied the same commuting ops in a different order serialise the same
    bytes.
  - `@montaj/edg/ops`: `rebaseOps(incoming, opsSince)` — the D29 transform table.
    Last writer wins per `(target, field)` for the scalar fields; a `Resegment`
    since the base revision invalidates segment-addressed ops but keeps
    word-level ones; a word deleted since the base makes any op naming it
    `stale`; a concurrent edit of the same text — `EditWord` on one word,
    `SetSegmentText` on one `(segment, script)` — is a `conflict` rather than a
    silent drop, so the 409 carries both texts and the client resolves it;
    segments merged away are remapped onto the segment that swallowed them where
    the op still means something, and a `MergeSegments` list grows the children
    of any segment split since the base. It reads only ops, never the document.
  - `MergeSegments` spans the outermost words of the segments it joins rather
    than the first and last segment's own ends: `seq` decides what shows when and a
    client may set bounds that do not follow the transcript, so taking the ends on
    trust could leave a caption whose range ran backwards. Found by the projection
    property, not by a hand-written case.
  - `@montaj/edg/ops`: `snapshot`/`restore`/`replay` over `EdgSnapshotSchema`
    (`{schemaVersion: 2, projection, chunks?}`), and the types-only
    `EdgRepository` (`loadHot`, `loadSegments`, `loadItems`, `appendRevision`
    returning either the new revision or `{latestRevision, opsSince}`,
    `snapshotEvery = 100`) that A12 implements.
  - `@montaj/edg/segmenter`: `segmentWords` with the script-aware limits of
    `09 §3` — Latin 32 characters a line at 20 CPS, Devanagari 24 at 15, Tamil 22
    at 15, anything else 26 at 15 — detected per word by Unicode block, with
    speaker-change and sentence breaks, a 150 ms minimum breakable pause, 700 to
    6,000 ms captions and a merge pass that absorbs anything shorter. Deterministic
    by construction.
  - `@montaj/edg/migrations`: `migrate(snapshot, targetVersion)` with a registered
    `v1` to `v2` step that turns v1's flat word array and index-addressed
    `wordRange: [i, j]` segments into `transcript_chunks` with stable word ids,
    deriving the chunk index from the cumulative `chunkSizes` v1 stored (or from
    10-minute windows when it did not), preserving segment texts and timings.
  - Fixtures: `fixtures/segmenter-golden.json` (Roman Hinglish, Devanagari Hindi
    and Tamil, with the wrapped lines and their character counts so the limits can
    be reviewed by eye, regenerated by `pnpm --filter @montaj/edg golden:build`)
    and `fixtures/legacy-v1-document.json` for the migration test.
  - 253 tests at 98.9% lines and 92.9% branches, over the CONTRACTS section 9 gate
    of 90/85: a table-driven case per op (happy path and every rejection reason),
    the transform table case by case, and eleven fast-check properties — a batch
    that fully applied leaves the document untouched when it arrives twice and a
    replay never re-applies what already landed, commuting ops converge whatever
    the order, `validateProjection` holds after any random op sequence, `rebaseOps`
    never produces an op naming a tombstoned id and never drops a caption-text
    edit silently, and the segmenter covers every live word exactly once inside
    its limits, deterministically. Benchmarks: 1,000 ops on a 9,000-segment
    document in ~20 ms (budget 200 ms) and 54,000 words segmented in ~205 ms
    (budget 500 ms).

- **A04 — api: auth (email/password, Google PKCE, magic link, refresh families,
  device grant, token exchange, sessions).**
  - `apps/api/src/auth/`: sign-up with the D60 age gate (India under 18 and the EU
    under 16 are refused with `auth/age_restricted` and offered a parental-consent
    waitlist) and per-purpose consent written into `consent_records`; email
    verification and magic links as single-use Redis tokens; login over argon2id
    (64 MiB, t=3, p=1) with a feature-flagged, fail-open breached-password check
    against HIBP's k-anonymity range API; Google sign-in with PKCE, a single-use
    state entry and a handoff code so no token ever rides in a redirect URL, plus
    the https `/auth/desktop-landing` page that triggers the deep-link scheme for
    desktop and panel clients; the RFC 8628 device grant with an 8-character
    unambiguous user code, a 10-minute TTL, a five-per-address cap on flows in
    flight, a server-enforced poll interval and an approval screen naming the host
    application, the device, the address and a coarse location; RS256 access
    tokens carrying exactly the CONTRACTS section 5 claims; refresh-token families
    rotated in place with a 60-second grace that replays the same pair, and reuse
    outside the window revoking the whole family and auditing it; workspace token
    exchange, session listing and session revocation.
  - `apps/api/src/common/guards/`: `JwtAuthGuard`, `RolesGuard`, `ApiKeyGuard`
    (B14 issues the keys; the guard and the scope check ship now), `@Public()`,
    `@Roles()`, `@CurrentUser()`, `@CurrentWorkspace()`, and a Redis token-bucket
    rate limiter behind `@RateLimit(...)` that answers 429 with `Retry-After`.
  - `apps/api/src/users/`: the minimal accounts surface auth needs — create a user
    with a personal workspace, an owner membership and the consent rows in one
    transaction, look one up, and answer membership questions.
  - `pnpm gen:client` regenerates `packages/api-client/openapi.json` and
    `src/generated/operations.ts` from the API's own OpenAPI document.
  - `TRUST_PROXY` (local process setting, not part of CONTRACTS section 1): the API
    reads the client address from `X-Forwarded-For` only when it is `1`, so per-IP
    rate limits cannot be side-stepped by setting the header.
  - Tests: 53 e2e cases against a real PostgreSQL and Redis (testcontainers) plus
    unit suites for the token service, the password policy, the guards, the age
    gate and the token primitives. THREAT-MODEL T1–T4 are mapped to evidence in
    `apps/api/src/auth/README.md`.
  - Fixed `apps/api/vitest.config.ts`: `mergeConfig` takes two configs and a
    boolean, so the four-argument call had been silently dropping the CONTRACTS
    section 9 coverage gate and the exclude list.

- **A08 — api: jobs module, realtime gateway, idempotent completion callbacks,
  no-op `CreditsFacade`, admission control.**
  - `apps/api/src/jobs`: `JobsService` — the producer for every queue in
    CONTRACTS section 3 — with the enqueue order that makes the whole thing safe
    (dedupe by `jobKey`, admission control, `jobs` row, `CreditsFacade.reserve`,
    BullMQ add, `job_events`), so a job that reaches Redis always has a row and a
    credit hold behind it and every earlier failure unwinds cleanly. Cursor-paged
    `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/events` and
    `POST /jobs/{id}/cancel`, all scoped to the token's workspace, with another
    workspace's job answering 404 rather than 403 (THREAT-MODEL T5).
  - **Admission control** (THREAT-MODEL T23): per-workspace enqueued-credit cap
    (429 `jobs/enqueue_cap`), concurrency lane (429 `jobs/concurrency_cap`),
    per-plan `maxQueueWaitMs` swept every 30 s into `jobs/queue_timeout` with the
    hold released, and the free-tier daily allowance enforced in the facade.
  - `apps/api/src/internal`: the signed worker callbacks —
    `POST /internal/jobs/{id}/progress`, `/complete`, `/enqueue-child` and
    `PATCH /internal/media/{id}` — behind `X-Montaj-Signature`
    (`hmac_sha256(secret, timestamp + "." + rawBody)`), a five-minute skew window
    and constant-time comparison. Completion is idempotent on `(jobId, attemptId)`
    through a conditional `UPDATE ... WHERE status IN ('queued','running')`, so a
    replay answers 200 and settles nothing (THREAT-MODEL T8/T9). Two-key rotation
    via the new optional `INTERNAL_CALLBACK_SECRET_NEXT`. The whole surface is
    excluded from `/docs`.
  - `apps/api/src/realtime`: `/realtime` over plain `ws` — authentication at the
    upgrade (`Sec-WebSocket-Protocol: aksharo.v1, bearer.<token>`, or an
    `Authorization` header), rooms `project:{id}` / `workspace:{id}` authorised
    against the token's workspace _and_ a live membership, Redis pub/sub fan-out
    with reference-counted subscriptions, a 30-second heartbeat and documented
    reconnection semantics (`apps/api/src/realtime/README.md`). The four events of
    CONTRACTS section 7 are typed now; A12 and B15 emit two of them later.
  - `apps/api/src/credits`: the CONTRACTS section 4 `CreditsFacade` interface plus
    a `grantLot` signature for Wave 3, and `NoopCreditsFacade` — real shape, real
    idempotency, no ledger. B02 changes one `useClass`.
  - `apps/api/src/common/scheduler`: `ScheduledTasksService`, cron for the API on
    BullMQ job schedulers, so periodic work is one registration rather than a
    timer per module. `jobs.queue-timeout` is its first task.
  - `tools/runbooks/queue-drain.js`: pause a queue, wait for its active jobs to
    drain with a timeout, print the counts; `--status`, `--resume`, `--json`.
  - New optional environment variables: `INTERNAL_CALLBACK_SECRET_NEXT`
    (CONTRACTS section 1, rotation), and the non-contract `MONTAJ_QUEUE_PREFIX`
    (defaults to BullMQ's own `bull`) and `MONTAJ_SCHEDULER_DISABLED`.
- **A03c — api: `PassStatus.succeeded` becomes `ready`.**
  - `@montaj/edg`'s `PassStatusSchema` is the source of truth for the pass
    lifecycle; A03 had written `succeeded` by analogy with `JobStatus`, but a pass
    whose job succeeded is not finished — its items are `ready` for review, and
    only a `MergePass` op moves it to `merged`. Migration
    `20260902020000_pass_status_ready` renames the value in place (no row rewrite);
    `JobStatus.succeeded` is untouched, since it mirrors the completion callback of
    CONTRACTS section 3.
  - The integration suite now compares `PassStatus` and `ItemState` in the database
    against the package's own enums, so this class of drift fails a test instead of
    reaching a client.

- **A03b — api: seq is a base-62 string; style loader hardened.**
  - `edg_segments.seq` becomes `text COLLATE "C"` (migration
    `20260902010000_edg_segment_seq_text`). A03 read 06's "seq numeric" literally;
    A02 has since shipped `seqBetween()` in `@montaj/edg`, which returns base-62
    keys such as `1B` and `Zz` that no NUMERIC column can hold. The alphabet
    `0-9A-Za-z` is in ASCII order so that `ORDER BY seq` is the comparison
    `compareSeqKeys()` makes, which holds only under byte collation — pinned on the
    column because managed Postgres usually defaults to a linguistic one, and
    asserted by a test that inserts `1`, `1B`, `2`, `Zz`, `a`, `zzzV`.
  - `edg_segments_live_seq_idx` becomes UNIQUE: two _live_ segments may not share a
    fractional key. Partial rather than a plain unique constraint, because a
    tombstoned segment keeps its key and a later edit may legitimately reclaim it.
  - The seed's style loader takes an injected module loader, so the fixtures and
    placeholder tiers stay testable now that `@montaj/caption-styles` always
    resolves; the fixtures tier accepts only documents that parse as StyleDoc v2
    with an `id`, so `styles/registry.json` — the catalogue index A02 ships
    alongside the styles — is no longer seeded as a style.
  - `pnpm db:seed` now reports `source: package` and seeds A02's seven system
    styles.

- **A02c — `@montaj/timemap`: source ↔ output time mapping (D30).**
  - `buildTimeMap({sourceDurationMs, edits, fps?, snapCutsToFrames?})` turns a list of
    `cut`, `speed` and `hold` edits into a frozen, ordered span list covering both
    clocks, with `O(log n)` lookups either way: `toOutput` (`null` strictly inside a
    cut), `toSource` (total — the inverse used for scrubbing), `locateSource` /
    `locateOutput` for the same answers with `insideCut`, `held` and `clamped` attached,
    and `mapRange` for a source range split by cuts.
  - Sample-accurate boundary rules: a cut removes the half-open source range, both its
    edges map to the one output splice, and `toSource` of that splice is the frame after
    the cut. Cuts win every conflict — overlapping and touching cuts merge, speed ranges
    are clipped out of them, holds strictly inside one are dropped — and structurally
    invalid edits raise a typed `TimeMapError` with a stable `code`.
  - Caption helpers: `mapSegment` (a segment whose live words all fall in cuts is
    hidden, partial overlaps are clipped, tombstoned words ignored) and `mapWord`;
    `mapKeyframes`, which drops keyframes inside cuts and pins the curve with an edge
    keyframe at each side of every splice it crosses, optionally interpolated.
  - `fromAcceptedItems(items, {sourceDurationMs, …})` builds a map from accepted `cut`
    pass items and ignores every other kind; `serialize()` / `parseTimeMap()` are a
    versioned JSON fixed point; `snapToFrame`/`frameDurationMs`/`frameAt` work on the
    exact frame grid, and `snapCutsToFrames` puts every cut edge on a boundary.
  - Guarantees proved with fast-check: monotonicity both ways, exact inverse on retained
    source when nothing is retimed (and a stable round trip on both clocks for every
    map), `outputDurationMs === sourceDurationMs − Σcuts + Σholds`, and `mapRange` pieces
    that are ordered, disjoint and cover exactly the retained part of the input range.
  - Pure and browser-safe (no Node-only imports, asserted against the build output);
    CommonJS in `dist/` and ES modules in `dist/esm/` with declarations for both.
    149 tests, 100% lines / 99.6% branches against the CONTRACTS section 9 gate (90/85).
    5,000 cuts on a six-hour source: 100,000 `toOutput` lookups in ~15 ms.
- **A03 — api: Prisma schema v2, hand SQL, migrations, seed, base modules.**
  - `apps/api/prisma/schema.prisma`: 68 models covering every table in
    `03-architecture/06-data-model.md` — identity and tenancy, media and editing
    (EDG v2, including `transcript_chunks`, the six `edg_*` tables, `style_presets`,
    `brand_kits`, `fonts`, `memory_entries`, `comments`, `share_links`,
    `share_reports`), jobs and outputs (with `provider_submissions` and
    `export_manifests`), billing and credits (`mandates`, Rule 46 `invoices`,
    `payments`, `firc_records`, `tax_registrations`, and the four credit tables),
    growth and the content/ops tables. ULID `char(26)` ids, `timestamptz`
    throughout, money as integer minor units beside a currency, credits as integer
    tenths, snake_case columns, and every JSONB column commented with the Zod
    schema that validates it.
  - `apps/api/prisma/sql/`: hand-maintained DDL applied straight after
    `prisma migrate deploy` — the `vector` extension, 31 partial and vector indexes
    (lot consumption order with `NULLS LAST`, retention sweeps, live-session and
    pending-device-code slices, an HNSW cosine index on `audio_assets.embedding`,
    and NULL-safe uniqueness for system style presets), 13 CHECK constraints
    holding the invariants of 06 (no UPI mandate above ₹15,000, no negative credit
    balance or over-consumed lot, a State code on every Indian invoice), and table
    comments recording the retention rules where `\d+` shows them.
  - `pnpm --filter @montaj/api db:migrate` (migrate deploy + idempotent hand SQL,
    tracked in `_montaj_sql_applied`), `db:seed`, `db:reset`, `db:sql`;
    `prisma generate` wired into `postinstall` and `build`; the CONTRACTS section 9
    coverage gate for `apps/api` (75/70).
  - `prisma/seed.ts`: the five plans of `04 §Plans` with INR/USD prices, monthly
    credit grants and entitlements whose operation gating is **derived** from the
    burn-rate table in `@montaj/config`; the system caption styles with their
    parity flags left at the pessimistic defaults only the A18a gate may write;
    four feature flags, all off; an admin user and a demo personal workspace with a
    credit account, lot and ledger row that satisfy invariant 1, and a free-plan
    subscription. Idempotent: every row is keyed on a natural key or a
    deterministic ULID.
  - `apps/api/src/common`: `PrismaService` (eager connect, shutdown hooks,
    `withTransaction`), `RedisService`, pino logging with request-id correlation
    and redaction of secrets and emails (THREAT-MODEL T21), an AsyncLocalStorage
    `RequestContext` carrying `requestId`/`userId`/`workspaceId`, a global
    exception filter producing the CONTRACTS section 8 envelope, a thin Zod
    validation pipe with `zodDto()`, and an OpenTelemetry bootstrap that is a
    genuine no-op when no OTLP endpoint is configured.
  - `GET /health/ready` reports Postgres, Redis and object-store reachability and
    answers 503 when any of them is down; `GET /health` stays dependency-free.
  - 109 tests: unit suites for redaction, request context, error codes, the
    exception filter, the validation pipe, telemetry and the health service; HTTP
    e2e for the error envelope (unknown route and validation failure) with no
    infrastructure; and an integration suite on a testcontainers
    `pgvector/pgvector:pg16` asserting all 68 tables against `information_schema`,
    the named indexes and constraints, seed idempotency, and a segment round trip
    in fractional `seq` order.
- **A02 — `@montaj/edg` v2 and `@montaj/caption-styles` v2 schemas + fixtures.**
  - `@montaj/edg`: Zod schemas and inferred types for the whole EDG v2 document —
    `WordId`, `Word`, `TranscriptChunk`, `TranscriptManifest`, `Segment`, `Pass`,
    `PassItem` (a discriminated union with a typed payload per `kind`), `EdgHot` and
    `EdgProjection` — plus the complete 16-member `EdgOp` union and the
    `OpBatchRequest`/`OpBatchResponse`/`OpConflict` envelopes from CONTRACTS section 2.
  - `@montaj/edg` helpers: a monotonic ULID factory, `makeWordId`/`parseWordId`,
    base-62 fractional ordering for `Segment.seq` (`seqBetween`, proved with
    fast-check), `buildWordIndex`/`wordsBetween` over transcript chunks, and
    `validateProjection` for the document invariants.
  - `@montaj/edg` artefacts: `schemas/edg-v2.json` and `schemas/edg-ops-v2.json`
    generated from the Zod schemas at build time and guarded by an "up to date" test;
    `fixtures/sample-project.json` (90 s, 3-speaker Hinglish, 12 segments, an autocut
    pass with 4 cut items and a reframe pass with 1 zoom item) with its matching
    transcript, validated by Ajv against the generated schema.
  - `@montaj/edg` build: CommonJS in `dist/` and ES modules in `dist/esm/`, each with
    declarations, behind the `.`, `./schemas` and `./seq` subpath exports.
  - `@montaj/caption-styles`: the `StyleDoc` v2 schema (typography, colours, box,
    stroke, shadow, layout, animation, emphasis presets, `minPlan`, CI-written parity
    flags), the D64 naming-rule validator with an admin-extendable deny-list in
    `src/naming/denylist.json`, seven system styles (`punch-pop`, `hype-bold`,
    `vertical-clean`, `karaoke-fill`, `podcast-duo`, `word-pop`,
    `minimal-lower-third`), a 30-style `styles/registry.json` and
    `loadSystemStyles()`, which A03's database seed loads.
  - Coverage gates per CONTRACTS section 9: 90/85 on both packages.

- **A01 — Monorepo scaffold, tooling, CI, docker-compose, env.**
  - pnpm 9 workspaces (`apps/*`, `packages/*`, `plugins/*`, `engine/*`) driven by
    Turborepo 2, with cached `build`, `lint`, `typecheck`, `test`, `test:e2e`,
    `db:migrate` and `db:seed` tasks.
  - `@montaj/config`: strict TypeScript bases (ES2022, NodeNext, React), the shared
    ESLint flat config, the Prettier config and the Vitest preset; `BRAND` per
    CONTRACTS section 0; the credit burn-rate table as typed constants; a Zod schema
    for every variable in CONTRACTS section 1 with a fail-fast `loadEnv()`.
  - Package skeletons with a passing test and a README each: `edg`, `timemap`,
    `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`,
    `ass-exporter`, `api-client`, `ui`, `prompts`.
  - `apps/api`: NestJS 11 with `GET /health`, OpenAPI at `/docs` (JSON at
    `/docs-json`), a config module built on `loadEnv()`, an empty Prisma schema plus
    `prisma/sql/` for hand-maintained DDL, and a supertest e2e suite.
  - `apps/web`: Next.js 15 App Router, React 19, Tailwind v4 and shadcn/ui, with a
    placeholder page per route group (`(site)`, `(app)`, `(share)`, `(admin)`), a
    `/health` route handler and a Playwright smoke test on chromium and webkit.
  - `apps/worker-media`: BullMQ worker on `media.probe` with a stub processor and an
    ffmpeg/ffprobe boot check that refuses to start with clear install instructions.
  - `apps/worker-ai`: Python 3.12 project (pip-tools locks, ruff, `mypy --strict`,
    pytest, hypothesis) with a BullMQ worker on `ai.transcribe`, a FastAPI control
    app serving `GET /health`, and the abstract `Provider` interface.
  - `apps/render`: BullMQ worker on `render.video` with a stub processor.
  - README-only placeholders for `apps/desktop`, `apps/bridge`, `plugins/premiere-uxp`,
    `plugins/ae-cep`, `plugins/resolve` and `engine/montaj-engine`.
  - `docker-compose.yml`: Postgres 16, Redis 7 and MinIO with healthchecks, plus a
    one-shot `mc` bootstrap creating `montaj-raw` and `montaj-derived`; and
    `docker-compose.override.example.yml`.
  - `.env.example` covering all 31 CONTRACTS section 1 variables with local defaults.
  - GitHub Actions CI: TypeScript (Node 22), Python (3.12), a Playwright smoke lane
    and a `docker compose config` lane, with a concurrency group.
  - Repo hygiene: `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`,
    `.node-version`, `CODEOWNERS`, `LICENSE`, the pull-request Definition-of-Done
    template, and `docs/adr/0001-monorepo-tooling.md`.

- **X05 — Infrastructure as code (staging/prod skeleton, no apply).**
  - `infra/terraform`: root modules `envs/staging` and `envs/prod` over nine
    reusable modules — `network` (VPC, three subnet tiers, NAT, S3 gateway
    endpoint, flow logs), `eks` (control plane, managed node groups with an
    optional GPU pool, addons, IRSA, access entries), `rds-postgres16` (PITR,
    KMS-encrypted, `pg_stat_statements` preloaded, `vector` allow-listed for
    A03's pgvector column), `elasticache-redis7` (`maxmemory-policy noeviction`,
    a BullMQ correctness requirement), `s3-raw` (`ap-south-1`, SSE, versioning
    with 7-day non-current expiry, 1-day abort-incomplete-multipart, CORS for
    presigned PUT from `WEB_ORIGIN`), `r2-derived` (bucket, CORS, and a
    multipart-abort rule on the `ws/` root — plan retention is swept by the
    scheduler in B16, not by lifecycle, because CONTRACTS section 6 keys are
    frozen), `secrets` (KMS plus one SSM parameter per
    CONTRACTS section 1 variable), `dns-cdn` (`aksharo.ai`, `app.`, `api.`,
    zone TLS settings, null-MX/SPF/DMARC) and `github-oidc` (keyless deploy
    role). `backend.tf` is a partial S3 backend with native locking; every
    variable is documented; no credential is committed.
  - `infra/gpu`: RunPod serverless endpoint definition with a warm floor of one
    per region and queue-delay autoscaling (decision D15), the model-server
    Dockerfile with large-v3-turbo, forced alignment and pyannote community-1
    pre-baked, a Modal equivalent, and `COST.md` showing the arithmetic behind
    the `05 §12` cost band rather than restating it.
  - `infra/k8s/montaj`: Helm chart for `api`, `web`, `realtime`, `worker-media`,
    `worker-ai`, `render` and `scheduler`, with HPAs on CPU for the
    request-serving components, KEDA ScaledObjects on BullMQ queue depth for the
    workers, PodDisruptionBudgets, default-deny network policies plus an optional
    Cilium FQDN allow-list, external-secrets pulling all 31 contract variables
    from SSM, TLS ingress, resource requests and limits, and
    `values-staging.yaml` / `values-prod.yaml`.
  - `infra/observability`: `METRICS.md` defining the OTel metric contract
    (names, units, labels, cardinality rules); two Grafana dashboards covering
    API latency, queue depth per queue, job success rate, GPU utilisation and
    COGS per credit; and a `PrometheusRule` with 4 recording rules and 24 alerts.
  - `docs/runbooks/`: deploy, rollback, rotate secrets, restore from PITR, scale
    GPU, DLQ replay and a breach first-hour checklist wired to THREAT-MODEL.
  - `.github/workflows/infra.yml`: the `infra-validate` job — `terraform fmt`,
    `terraform validate` against a mock backend for every module and both
    environments, `tflint`, `helm lint`, `kubeconform -strict`,
    `promtool check rules`, plus checks that the SSM map and the chart match
    CONTRACTS section 1 exactly, that the lifecycle rules encode the retention
    contract, that worker egress is denied by default, and that nothing
    credential-shaped is committed.

### Fixed

- **A08b — `jobKey` deduplication was scoped globally, not per workspace.** A08's
  `jobs_live_job_key_key` was `UNIQUE (job_key) WHERE status IN
('queued','running')` with no workspace column, so two tenants with the same
  live job key collided and the second enqueue failed with an unexplainable unique
  violation. `prisma/sql/0005-a08b-dlq.sql` replaces it with
  `jobs_live_workspace_job_key_key` on `(workspace_id, job_key)`, and
  `JobsService.enqueue` now handles the unique violation by returning the existing
  job — the `findLiveByKey` read cannot exclude a writer that commits a
  microsecond later, so the index is the actual guarantee.

### Changed

- **A25** — `.env.example`, `packages/config/src/env.ts`, the Terraform secrets
  contract and the Helm chart all gained `MAIL_PROVIDER`, `MAIL_FROM` and
  `SMTP_URL`, the three variables CONTRACTS section 1 added after A04, and
  `GPU_PROVIDER_URL` (non-secret) and `GPU_PROVIDER_TOKEN` (secret, human-filled),
  the two it added after A09 — A25 was the next work package to touch all four
  files, so it carried them across rather than leaving the parity check red.
  `MAIL_SNS_TOPIC_ARN` followed after A25's first review.
  `apps/worker-ai/worker_ai/settings.py` mirrors that list and its test enforces
  the mirror, so the six names were added there too and the GPU pair moved out
  of `WORKER_ENV_VARS`: they are product configuration now, not deployment
  naming. `infra/scripts/check-contracts-parity.py` reports 38/38 on both sides.
  `loadEnv()` also gained a cross-field check (`crossFieldProblems`): `ses` and
  `smtp` require `MAIL_FROM`, and `smtp` requires `SMTP_URL`. It lives beside the
  schema rather than inside it because a `.superRefine()` would remove
  `envSchema.shape`, which the contract test walks.
- **A25** — `REALTIME_EVENTS` gained `notification.created`, now also named in
  CONTRACTS section 7.
- **A25** — `UsersService.findByEmail` selects `locale`. It is the only lookup the
  auth flows do before sending a message, and A25 renders that message in the
  recipient's language; the alternative was a second query on the sign-in path.

- **A02b** — `OpRejectionReasonSchema` gained `invalid-range`, `not-contiguous`,
  `invariant`, `rebased-away` and `stale-after-resegment`. The reason list is a
  closed enum that the ops engine was always meant to extend rather than send free
  text (A02 said so in `packages/edg/README.md`); `schemas/edg-ops-v2.json` is
  regenerated to match. `EdgSourceSchema` was lifted out of `EdgOpsEventSchema` so
  the engine can name the writer that submitted a batch — the same six values,
  now a `$def`.
- **A03** — `docker-compose.yml` now runs `pgvector/pgvector:pg16` instead of
  `postgres:16`. `audio_assets.embedding` is a `vector(512)` column, so stock
  Postgres cannot apply the first migration. Managed Postgres needs `vector` on
  its extension allow-list (X05).
- **A03** — `@typescript-eslint/consistent-type-imports` is off for
  `apps/api/src/**`. A constructor parameter's type is the DI token NestJS resolves
  from `design:paramtypes`, and `import type` erases it to `Object`, so the
  provider fails to resolve at runtime while the code still type-checks.

[Unreleased]: https://github.com/aksharo/montaj/compare/main...HEAD
