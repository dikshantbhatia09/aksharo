# @montaj/web

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4. One codebase for
the marketing site and the studio, split by route group.

**Status:** A13 — the app shell, the auth screens, onboarding, settings and the
client layer; A16's caption canvas and right panel at `/studio/styles`; A15's
editor at `/p/{id}`. A14, A17 fill in Home/Projects and the timeline; A24 the
marketing site.

## Route groups

| Group     | URL           | Purpose                                       | Built in |
| --------- | ------------- | --------------------------------------------- | -------- |
| `(site)`  | `/`, `/login` | marketing and everything reachable signed out | A13, A24 |
| `(app)`   | `/studio`     | the authenticated studio, inside the shell    | A13–A17  |
| `(share)` | `/share`      | public review links, comments, approvals      | B15      |
| `(admin)` | `/admin`      | staff console behind its own guard + MFA      | B13      |

Route groups do not affect the URL — `app/(site)/page.tsx` is `/`. They exist so
each surface can own its layout and auth boundary.

## Routes A13 owns

| Route                                    | What it is                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `/signup`                                | credentials, then onboarding **step 0** (age + consents, D60)                    |
| `/login`                                 | password or Google; `?next=` is followed only when same-site                     |
| `/magic`                                 | request a sign-in link, and consume one with `?token=`                           |
| `/verify`                                | confirm an address, then on to sign in                                           |
| `/auth/verify-email`, `/auth/magic-link` | where A04's emails point; they forward to the two above                          |
| `/auth/callback`                         | Google returns here; `status=registration` asks step 0 before the account exists |
| `/auth/desktop-landing`                  | triggers the `aksharo://` deep link with a visible fallback                      |
| `/device`                                | device-code approval (host app, device, address, location)                       |
| `/studio`                                | the shell's landing page until A14 builds Home                                   |
| `/onboarding`                            | steps 1–3: what you make, languages, how you found us                            |
| `/settings/*`                            | profile, languages, what Aksharo learned, devices, privacy, notifications        |
| `/ui-kit`                                | every component state, for screenshot review                                     |
| `/studio/styles`                         | A16's style harness: the caption canvas and the right panel                      |
| `/p/{id}`                                | A15's editor: transcript, caption preview, style panel, in one store             |
| `/api/session`, `/api/session/refresh`   | the only code that may touch the refresh token                                   |

## Sessions

The **refresh token** lives in an httpOnly, SameSite=Lax cookie that only the
route handlers in `app/api/session/` can read (THREAT-MODEL T2). The **access
token** lives in memory for its 15 minutes and is never persisted. Nothing
security-relevant is in `localStorage`.

That shape has three consequences worth knowing:

1. `POST /api/session` stores a token pair after any successful sign-in, and
   `POST /api/session/refresh` rotates server-side, so there is exactly one
   writer for the cookie and CONTRACTS §5's 60 s grace behaves when two tabs
   race.
2. Both handlers reject a cross-site request, because a route that writes a
   session cookie is a session-fixation primitive otherwise.
3. `middleware.ts` redirects a request with no cookie away from `/studio`,
   `/settings`, `/onboarding`, `/device` and `/p` before any HTML is sent — a
   routing decision, not an authorisation one. The shell still rotates on
   mount, because a cookie is not proof the family is alive.

## Configuration

Read on the server at request time (`lib/runtime-config.ts`), not inlined as
`NEXT_PUBLIC_*`, so one build runs in every environment: `API_ORIGIN`,
`POSTHOG_KEY`, `POSTHOG_HOST`, `SENTRY_DSN`, `FEATURE_FLAGS_JSON`.

Feature flags this app reads from `FEATURE_FLAGS_JSON` (CONTRACTS §1):

| Flag                  | Default | Effect                                                                                        |
| --------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `growth.streakWidget` | off     | Shows the streak badge on the credit meter (B06's experiment).                                |
| `realtime.enabled`    | on      | The shell's WebSocket. A kill switch: set it to `false` to stop connecting without a rebuild. |

## Privacy and analytics

`posthog-js` is imported **dynamically, after consent** — before that it is not
merely inert, it is not in the page and there is no request to any analytics host
(brief §7). D60 adds the second rule: a declared minor never gets analytics
whatever the toggle says, so the check runs on every call rather than once at
start-up. `lib/privacy/consent.ts` keeps the browser's mirror of what the user
agreed to; the server's `consent_records` remain the record.

Sentry (`@sentry/browser`) initialises only with a DSN, with tracing and session
replay off and every event through `scrubEvent` — addresses, JWTs, bearer headers
and signed URL parameters are replaced before anything leaves the browser.

## Run

```bash
pnpm --filter @montaj/web dev     # http://localhost:3000
```

## The caption canvas and the right panel (A16)

`components/editor/canvas/` and `components/editor/panels/` are the editor's
rendering surface, mounted for real by A15.

| Piece                | What it is                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| `use-canvaskit.ts`   | loads CanvasKit and HarfBuzz **once per page** and shares them                 |
| `StylePreviewCanvas` | one StyleDoc drawn live — a still, or its looping three-second preview         |
| `CaptionStage`       | the proxy `<video>` with the CanvasKit overlay, safe zones and a draggable box |
| `stage-geometry.ts`  | the letterbox fit, the drag maths and the safe-area clamp — pure, unit-tested  |
| `panels/ops.ts`      | every control's change as one `EdgOp` — pure, unit-tested                      |
| `RightPanel`         | the Style, Colors, Look and Anim tabs                                          |

The overlay is drawn by `renderFrame` — the same function the cloud renderer calls —
so what is on screen is what gets burned in. The clock is
`requestVideoFrameCallback`, not `timeupdate`, so the caption drawn belongs to the
frame actually presented; `timeupdate` would be up to 250 ms out and the karaoke
fill would visibly lag. Dragging the caption box emits exactly one
`SetSegmentPosition` per **drop**, never one per pointer move.

`/studio/styles` mounts the panel against the 30 system styles. It is a working
harness, not the editor: A15 replaces the catalogue with the workspace's own from
the API and wires the ops into the real op queue.

## The editor (A15)

`/p/{id}`: the transcript column (`components/editor/transcript/`, `lib/edg/`)
plus A16's `CaptionStage`/`RightPanel`, integrated rather than rebuilt.

| Piece                           | What it is                                                                 |
| ------------------------------- | -------------------------------------------------------------------------- |
| `lib/edg/store.ts`              | `EditorStore` — server/local `EdgState`, undo/redo, conflicts, resegment   |
| `lib/edg/queue.ts`              | `EdgOpQueue` — debounced batching, 409 rebase, offline retry               |
| `lib/edg/ops.ts`                | op builders, the panel-op adapter, `computeInverseOps`                     |
| `lib/edg/history.ts`            | the 100-step undo/redo stack, grouped per action                           |
| `lib/edg/virtual-list.ts`       | the transcript's variable-height windower (prefix-sum + binary search)     |
| `lib/edg/find-replace.ts`       | the matcher Ctrl+F and "fix spelling everywhere" share                     |
| `lib/edg/bulk-actions.ts`       | merge-short / split-long op planners                                       |
| `lib/edg/caption-budgets.ts`    | the D78 reflow check against `EdgHot.meta.engineVersions.captionBudgets`   |
| `lib/edg/keyboard-shortcuts.ts` | the 08 §4 keyboard map, one `window` listener                              |
| `lib/edg/render-projection.ts`  | `EdgState` → `@montaj/render-core`'s render-only `EdgProjection`           |
| `lib/edg/playhead.ts`           | a local scaffold for A17's shared `PlayheadStore` (not built yet)          |
| `components/editor/transcript/` | `WordChip`, `SegmentCard`, `TranscriptList`, dialogs, the bulk-actions bar |

**The store never trusts the network to be the only writer.** Every op is
applied optimistically (`localState = applyOps(serverState, pending)`); a
batch's `applied`/`rebased` opIds replay onto `serverState` on success, a 409
`conflict` shows both texts rather than picking one, and an `edg.ops` realtime
event from another session is folded in through the same `rebaseOps` the
server ran — never a second reconciliation path. `edg/too_stale` halts the
queue until `EditorStore.reload()` (see `CHANGELOG.md`'s A15 entry for the bug
that finding this the hard way fixed).

**Reflow is an offer, never automatic** (orchestrator addendum, D78): a style
or aspect change whose `fitBudget` disagrees with the budget recorded at
initialisation shows a banner; accepting it issues a server-minted
`Resegment` and reloads the document, because the response never carries it.

**Eager paging, not windowed-by-time.** The brief asks for segments and
transcript chunks to load "lazily by time window"; this pages every segment
and chunk up front instead (a 500-a-page segment list is a handful of
requests even at nine thousand segments) and leans on `TranscriptList`'s
virtualiser for scroll performance, which is what acceptance criterion 1
actually measures. Reported as a scoping simplification in the final report,
not a silent substitution.

### Runtime assets

CanvasKit's `.wasm` and the subset fonts must be served from the app's own origin —
a cross-origin `.wasm` fetch fails under the app's CSP, and a font the layout engine
cannot read is a caption that does not draw. They are **copies**, not committed
files:

```bash
pnpm --filter @montaj/web assets:render   # writes public/canvaskit/ and public/fonts/
```

The Playwright global setup runs it, so the e2e suite fails on a real bug rather
than on a missing 404. A18b replaces the three Noto subsets with the workspace's
real faces served from R2; the URLs the components fetch do not change.

## Tests

```bash
pnpm --filter @montaj/web test              # vitest units (lib/, components/, middleware)
pnpm --filter @montaj/web test:coverage     # the CONTRACTS §9 gate: 60/50
pnpm --filter @montaj/web test:e2e:install  # once: download Chromium + WebKit
pnpm --filter @montaj/web test:e2e          # Playwright, chromium + webkit
```

WebKit is a **blocking** lane, not a bonus: Safari is a large share of the Indian
mobile audience and its WebCodecs behaviour differs, so the browser-native export
(A19) has to work there too.

The Playwright config starts **both** servers: the API from `apps/api` on its own
port with `TRUST_PROXY=1`, and a production build of this app. It needs the
repository `.env` (its `DATABASE_URL` must point at a migrated, seeded database)
and the compose Redis, which is where A04 writes auth emails in development —
`e2e/fixtures.ts` reads the confirmation token straight out of that outbox.

Each test gets its own `X-Forwarded-For`, because the API's rate limits are per
address and a suite that signs up a dozen accounts from one address exhausts
`auth:signup:ip` halfway through. A test that only needs _a_ session takes the
worker's `sharedAccount` fixture instead of creating another: the dev outbox is a
50-entry Redis list shared with every other work package's local API, and a
suite that pushes eighteen messages through it loses its own.

`/ui-kit`, the auth screens, the shell, onboarding and every settings screen are
screenshotted into `e2e/__screenshots__/` (gitignored — they are review
artefacts) and checked with axe; serious and critical violations fail.

`editor.spec.ts`/`editor-performance.spec.ts` (A15) seed a project through the
**real** write path rather than a fixture the API never sees: sign in, `POST
/projects`, one `media_assets` row inserted directly (`role: primary, status:
ready` — the one step a real upload+ffprobe would otherwise take, out of this
work package's scope), `POST /transcribe`, then the worker's own signed
completion callback (`editor-fixtures.ts`, CONTRACTS §3 HMAC) with a small
Hinglish fixture or, for the performance test, an 18-chunk, ~54,000-word one.
`editor-performance.spec.ts` scrolls the transcript list programmatically for
2 s on chromium and asserts ≥ 55 fps (acceptance criterion 1), logging the
measured number.

## Notes

- `@montaj/ui` and `@montaj/api-client` are in `transpilePackages`: the first
  ships source with `"use client"` boundaries, and the second would otherwise be
  required as CommonJS on the server while the app imports the ESM build of
  TanStack Query — two `QueryClient` contexts and a very confusing error.
- `next-env.d.ts` is committed, unlike the Next.js default, so `tsc --noEmit`
  works before a build has ever run.
- `eslint.ignoreDuringBuilds` is on because linting is its own turbo task using
  the shared flat config; the build must not run a second, different pass.
