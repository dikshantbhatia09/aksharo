# CONTRACTS.md — Frozen interfaces (Wave 1). Change only via an ADR approved by Fable.

## 0. Naming
- Package scope `@montaj/*`; apps `apps/web`, `apps/api`, `apps/worker-media`, `apps/worker-ai`, `apps/render`, `apps/desktop`, `apps/bridge`; plugins `plugins/premiere-uxp`, `plugins/ae-cep`, `plugins/resolve`; engine `engine/montaj-engine`.
- **Codename vs brand.** `montaj` is the internal engineering codename only (repo folder, `@montaj/*` package scope, queue names). The **brand is Aksharo** (decision D59): brand strings only in `packages/config/src/brand.ts` (`BRAND = { name: "Aksharo", domain: "aksharo.ai", altDomain: "aksharo.in", deepLinkScheme: "aksharo", supportEmail: "support@aksharo.ai" }`). The codename must never appear in UI copy, domains, bundle ids, plugin ids/names, installer names, OAuth client names or marketing. Plugin/bundle ids use the brand: `ai.aksharo.panel` (Premiere UXP), `ai.aksharo.ae` (AE CEP), `aksharo_core` (Resolve). Host apps are referenced only as compatibility statements ("works with Adobe Premiere Pro"), never inside product names.
- IDs: ULID strings. Times: `timestamptz` in DB, ISO-8601 in JSON, milliseconds (`*Ms`) for media time. Money: integer minor units + ISO currency. Credits: integer tenths (`*Tenths`).

## 1. Environment variables (`.env.example` must list all)
`DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_RAW`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `R2_ENDPOINT`, `R2_BUCKET_DERIVED`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `INTERNAL_CALLBACK_SECRET`, `INTERNAL_CALLBACK_SECRET_NEXT` (optional; second valid verification key during rotation — added 2026-09-02 after X05), `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `WEB_ORIGIN`, `API_ORIGIN`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SARVAM_API_KEY`, `ELEVENLABS_API_KEY`, `ASSEMBLYAI_API_KEY`, `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GPU_PROVIDER`, `GPU_PROVIDER_URL` (serverless GPU endpoint; non-secret), `GPU_PROVIDER_TOKEN` (secret) — both added 2026-09-02 after A09, `SENTRY_DSN`, `POSTHOG_KEY`, `FEATURE_FLAGS_JSON`, `MAIL_PROVIDER` (`ses|smtp|dev`), `MAIL_FROM`, `SMTP_URL` (optional secret; local Mailpit or self-hosted SMTP), `MAIL_SNS_TOPIC_ARN` (optional; when set, SES bounce/complaint notifications from any other topic are rejected — added 2026-09-02 after A25), `LICENSE_SIGNING_KID` (key id stamped on licence-key and revocation-snapshot tokens signed with the JWT RSA pair; default `k1` — added 2026-09-02 after B08; recorded here 2026-09-03). Release-pipeline secrets (Apple notarytool, DigiCert KeyLocker, ZXP certificate, release bucket — C00) are CI/GitHub-environment secrets listed in `docs/RELEASE.md` and loaded from `tools/release/.env.example`; they are deliberately NOT part of this runtime contract (ruling 2026-09-03) — the three mail variables were added 2026-09-02 after A04 (A25 owns delivery; SES in cloud uses the pod's IRSA role, no key).

## 2. EDG v2 core types (`@montaj/edg`)
```ts
export type WordId = `${number}:${number}`;            // "<chunkIdx>:<n>", never reused
export interface Word { wid: WordId; s: number; e: number; t: string; c?: number; sp?: string;
  scripts?: Partial<Record<"roman"|"native"|"en", string>>; filler?: boolean; deleted?: boolean }
export interface TranscriptChunk { chunkIdx: number; startMs: number; endMs: number; words: Word[] }
export interface Segment { id: string; seq: string /* fractional index */; startWordId: WordId; endWordId: WordId;
  startMs: number; endMs: number; styleRef?: string; textOverrides?: Record<string,string>;
  emphasis?: { wordId: WordId; presetId: string }[]; position?: { x:number; y:number; anchor:string };
  overrides?: Record<string, unknown>; hidden?: boolean }
export type PassType = "autocut"|"reframe"|"sfx"|"music"|"textfx"|"prompted";
export type ItemKind = "cut"|"zoom"|"reframe"|"sfx"|"music"|"title";
export type ItemState = "proposed"|"accepted"|"rejected"|"modified";
// Keyframe payload rule (added 2026-09-03 after B19): zoom/reframe items carry `payload.keyframes` (base64 of the MKF2 packed form of Keyframe{tMs, zoom, cx, cy, ease} from @montaj/edg `passes/keyframes.ts`) when ≤ 64 KB, else `payload.keyframesRef` = derived key `ws/{workspaceId}/passes/{passId}/{itemId}.mkf` (§6) uploaded by the worker via presigned PUT; readers accept either. PassType includes "zoom" (B19b).
export interface PassItem { itemId: string; passId: string; kind: ItemKind; startMs: number; endMs: number;
  payload: Record<string, unknown>; keyframesRef?: string; confidence?: number; reason?: string; state: ItemState;
  licenceSnapshot?: Record<string, unknown> }
export interface EdgHot { meta: { edgId: string; projectId: string; revision: number; schemaVersion: 2; engineVersions?: Record<string,string> };
  media: { mediaId: string; role: "primary"|"broll"|"audio"; durationMs: number; fps?: number; width?: number; height?: number }[];
  transcript: { transcriptId: string; revision: number; language: string; scripts: string[]; speakers?: {id:string; name?:string; color?:string}[] };
  canvas: { aspect: "9:16"|"16:9"|"1:1"|"4:5"; width: number; height: number; safeArea?: unknown };
  styles: { defaultStyleId: string; inline?: Record<string, unknown>; templateId?: string; brandKitId?: string };
  audio?: Record<string, unknown>; render?: Record<string, unknown>;
  protected?: { id: string; s: number; e: number; reason?: "user"|"emphasis"|"override" }[] } // added 2026-09-02 after B18: user-marked ranges no pass may cut, zoom or reframe; the engine also derives implicit ranges from emphasis/textOverrides but only `reason:"user"` rows are stored
```
### EdgOp union (id-addressed; no array indices)
`SetSegmentText{segmentId, script, text}` · `SetSegmentBounds{segmentId, startMs, endMs, startWordId?, endWordId?}` · `SplitSegment{segmentId, atWordId, newSegmentId}` · `MergeSegments{segmentIds[], newSegmentId}` · `SetEmphasis{segmentId, wordId, presetId|null}` · `SetSegmentPosition{segmentId, position|null}` · `HideSegment{segmentId, hidden}` · `SetStyle{scope:"doc"|"segment", segmentId?, styleRef?, overrides?}` · `EditWord{wordId, text, script?}` · `DeleteWord{wordId}` · `InsertWordAfter{wordId, newWordId, text, s, e}` · `SetProtectedRanges{ranges:[{id,s,e}]}` (added 2026-09-02 after B18: replaces the user-marked `protected[]` set wholesale; rebase field `protected`, last-write-wins; ranges are clamped to media duration and merged when overlapping; `passes.service` sends the stored set as `protectedRanges` to every `ai.pass`) · `SetWordTiming{wordId, s, e}` (added 2026-09-02 after A17: word retiming from the timeline; rebase field `timing:<wordId>` is last-write-wins, `stale` after `DeleteWord` of that word, and the engine rejects `invalid-range` when `s ≥ e` or the new range overlaps the previous/next live word) · `Resegment{maxChars, maxLines, minMs, maxMs}` · `DecideItems{itemIds[], state}` · `EditPassItem{itemId, startMs, endMs}` (added 2026-09-03 after B20: user adjusts a proposed cut/zoom/reframe item's bounds on the timeline; only `proposed` or `accepted` items, clamped to media duration and to neighbouring accepted items of the same kind, keyframes re-based by the worker on the next pass or re-timed linearly by the engine; rebase field `item:<itemId>` last-write-wins, `stale` after the item is rejected/deleted) · `MergePass{pass}` (worker only) · `SetAudio{clean?: {enabled, cleanId?: string|null, preset?, targetLufs?}, ...}` (amended 2026-09-03 after B10: `cleanId` is a first-class field naming the `audio_cleans` row whose 48 kHz track replaces the source audio in exports; B10's interim `preset: "b10:<cleanId>"` encoding is removed by B10b) · `SetRender{...}`. Every op has `opId` (client ULID). Batch request `{baseRevision, ops, clientOpIds}`; response `{revision, applied, rebased, rejected:[{opId, reason}]}`; conflict 409 `{latestRevision, opsSince}`.

## 3. Queue contracts (BullMQ; Redis)
Queue names: `media.probe`, `media.proxy`, `ai.vad`, `ai.transcribe`, `ai.align`, `ai.diarise`, `ai.translate`, `ai.transliterate`, `ai.clean`, `ai.pass`, `ai.llm`, `render.video`, `render.subtitle`, `notify`.
Envelope (every job data): `{ jobId, attemptId, workspaceId, projectId?, priority, jobKey, createdAt, payload }`.
Completion callback: `POST {API_ORIGIN}/internal/jobs/{jobId}/complete` with headers `X-Montaj-Attempt: <attemptId>`, `X-Montaj-Timestamp`, `X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))`; body `{ status: "succeeded"|"failed", result?, error?, usage?: { mediaSeconds?, outputSeconds?, provider?, model?, costMinor?, egressBytes? } }`. The API verifies the signature against `INTERNAL_CALLBACK_SECRET` first and, when set, against `INTERNAL_CALLBACK_SECRET_NEXT` (two-key rotation); workers always sign with the primary they were given. Replays return 200 without side effects. Progress: `POST /internal/jobs/{jobId}/progress {progress, etaMs, message}` (same signature).
Python worker uses the official `bullmq` package pinned in `apps/worker-ai/pyproject.toml`; unsupported features (documented): flow producers, repeatable jobs, sandboxed processors — not used.

## 4. CreditsFacade (api-internal interface; Wave 1 no-op, Wave 3 real)
```ts
export interface CreditsFacade {
  reserve(input: { workspaceId: string; jobId: string; worstCaseTenths: number; reason: string }): Promise<{ holdId: string } >; // throws CreditsInsufficientError
  settle(input: { holdId: string; actualTenths: number }): Promise<{ settledTenths: number; deltaHoldId?: string }>;
  release(input: { holdId: string }): Promise<void>;
}
```
Every job producer must call `reserve` before enqueue and `settle`/`release` from the completion path. Burn rates from `packages/config/src/credits.ts`.

## 5. Auth
JWT (RS256) claims: `{ sub: userId, ws: workspaceId, role, kind: "web"|"desktop"|"bridge"|"premiere"|"ae"|"resolve"|"api"|"admin", jti, iat, exp(15m; 30m for "admin") }` (amended 2026-09-03 after B13: `kind:"admin"` is minted only by `POST /admin/auth/step-up` after a TOTP check on a user holding an `admin_roles` row; it carries `adminRoles: ("support"|"finance"|"ops"|"content"|"superadmin")[]`, is never refreshable, never issued to API keys or plugin/bridge clients, and `/admin/*` accepts nothing else). Bridge tokens (`kind:"bridge"`) additionally carry `deviceId` (a B08 device row owned by `sub`) so relay pairing is keyed per device, not per user — amended 2026-09-03 after C01; B08b mints them from a device lease and the relay rejects a bridge token without `deviceId`. Refresh: opaque token, family id, rotation with 60 s grace, reuse → family revoked. Endpoints per `03-architecture/07`. Device code: `{deviceCode, userCode (8 chars, no ambiguous glyphs), verificationUrl, interval, expiresIn ≤ 600}`.

## 6. Storage keys
Raw (S3): `ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}`. Derived (R2): `ws/{workspaceId}/p/{projectId}/media/{mediaId}/{audio16k.wav|audio48k.wav|proxy540.mp4|waveform.json|thumb-{n}.jpg|subtitle.json}` (`subtitle.json` = imported subtitle sidecar as a cue list, added 2026-09-02 after A06); exports `ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}`; fonts `ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}`; brand assets (watermarks, logos) `ws/{workspaceId}/brand/{assetId}.png` (added 2026-09-02 after A20).

## 7. Realtime
Rooms `project:{projectId}`, `workspace:{workspaceId}`; events `edg.ops {revision, ops, source}`, `job.progress {jobId, progress, etaMs}`, `job.completed {jobId, status}`, `comment.added`, `notification.created {notificationId, kind}` (added 2026-09-02 after A25; user-room delivery of in-app notifications). Bridge relay rooms `bridge:{workspaceId}` (Wave 4).

## 8. Error envelope
`{ error: { code, message, details?, requestId } }`; codes are `namespace/slug` (see `03-architecture/07`).

## 9. Testing conventions
Unit: vitest (TS) / pytest (Py). Integration: testcontainers. E2E: Playwright (chromium + webkit). Property tests: fast-check (TS) / hypothesis (Py) for credits and EDG ops. **Coverage thresholds** (lines/branches) enforced via `coverageThresholds()` from `@montaj/config`: `packages/edg`, `packages/timemap`, `packages/caption-styles`, `packages/render-core`, `packages/render-canvaskit`, `packages/render-skia-node`, `packages/render-manifest`, `packages/fonts`, `packages/ass-exporter` = 90/85; `apps/api`, `apps/worker-media`, `apps/render`, `apps/worker-ai`, `apps/model-server` = 75/70; `apps/web` = 60/50 (UI); generated code excluded. Each WP that creates a package adds its threshold.

## 10. Toolchain policy
Version pins chosen in A01 (Node 22, pnpm 9.15.9, TS 5.9, ESLint 9, NestJS 11, Next 15, Prisma 6, Vitest 3, Python 3.12) are the floor **until Gate A**; no WP upgrades majors. A dedicated upgrade WP (X07) runs after Gate A. `prisma generate` is wired into `apps/api` build/postinstall by A03.
