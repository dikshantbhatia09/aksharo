# Threat-model audit — 2026-09-03 (X01)

Re-verification of every row in `docs/THREAT-MODEL.md` before Gate C. Status
values: **implemented+tested** (control exists, a test exercises the negative
case), **implemented, untested** (control exists, no test failed when it was
disabled — none found in this pass), **missing** (no control found), **fixed
in this WP** (a real gap was found and closed here).

Evidence is `file:line` or a test name in the worktree at commit noted in the
final report. Severity on gaps only: Critical / High / Medium / Low, per the
usual CVSS-ish shorthand (auth bypass or data leak = High+; hardening = Low/Med).

| #   | Threat                                         | Status                                                                                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Credential stuffing / weak passwords           | implemented+tested                                                                                                                | `apps/api/src/auth/breached-password.service.ts` + `.test.ts`; rate limits `apps/api/src/auth/auth.constants.ts:105-113` (`loginIp`, `loginAccount`); `apps/api/test/auth.e2e-spec.ts` "rate limits" describe block (4 tests)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T2  | Refresh-token theft/replay                     | implemented+tested                                                                                                                | `apps/api/src/auth/session.service.ts` (rotation/grace/family); `apps/api/test/auth.e2e-spec.ts:328-431` "refresh rotation and reuse detection" (5 tests incl. reuse → `auth/session_revoked`, `auth.refresh.reuse_detected` audit row)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T3  | Device-code phishing / brute force             | **fixed in this WP** — see below                                                                                                  | `apps/api/src/auth/device.controller.ts`, `apps/api/src/auth/auth.constants.ts` (`deviceCodeIp`, `deviceApproveUser`, new `deviceDescribeUser`); `apps/api/test/auth.e2e-spec.ts` "device code" describe block                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T4  | Tenant confusion via workspace header          | implemented+tested                                                                                                                | `apps/api/test/auth.e2e-spec.ts` "ignores a workspace supplied in a header"; `apps/api/test/workspace-guard.e2e-spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T5  | IDOR on project/media/export ids               | implemented+tested                                                                                                                | ULIDs everywhere in `prisma/schema.prisma`; ownership checks e.g. `apps/api/test/exports.e2e-spec.ts:520` "refuses a refresh from another workspace with 404"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T6  | SSRF via user-supplied URLs                    | implemented+tested                                                                                                                | `apps/api/src/common/net/safe-fetch.ts` + `.test.ts`; call sites: `media/import/subtitle-import.service.ts`, `public-api/v1/source-url-ingest.service.ts`, `common/ssrf/webhook-fetch.ts`, `affiliates/payouts/razorpayx.provider.ts` (fixed base URL, not user input). SNS certificate fetch uses a hostname-anchored regex allowlist instead of `safeFetch` — reviewed, sound (`notify/sns/sns-message.ts:61-71`, anchored `^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$`), not a gap. No other raw `fetch(` of user-controlled input found (`grep` sweep of `apps/api/src` — see report).                                                                                               |
| T7  | Malicious uploads                              | implemented+tested                                                                                                                | `apps/api/src/media/media.service.ts` size/mime checks + `.test.ts` ("deletes the object and fails the row when the real size breaks the plan cap"); `apps/api/src/fonts/bundled-fonts.service.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T8  | Callback forgery / replay                      | implemented+tested                                                                                                                | `apps/api/src/webhooks/webhook-signature.test.ts` (HMAC + 5-min skew replay test); `apps/api/test/dlq.e2e-spec.ts`, `jobs.e2e-spec.ts` use the same signed-callback harness                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T9  | Credit double-spend / race                     | implemented+tested                                                                                                                | `apps/api/test/credits-ledger.e2e-spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T10 | Watermark/entitlement bypass (signed manifest) | implemented+tested                                                                                                                | `packages/render-manifest/src/manifest.test.ts` (tampered watermark, raised cap, expired, clock skew all refused); nonce single-use / replay tested end-to-end at `apps/api/test/exports.e2e-spec.ts:118-208` ("issues... first browser export" → complete → "replay is refused" 409 `export/manifest_already_consumed`)                                                                                                                                                                                                                                                                                                                                                               |
| T11 | Local bridge abused by hostile web page        | implemented+tested; **one deviation reviewed, see below**                                                                         | `packages/bridge-core/src/server.test.ts` "loopback HTTPS/WebSocket — negative security tests": no-bearer 401, wrong-bearer 401, disallowed Host 400, disallowed Origin 403, null Origin 403, oversized body/frame; `apps/api/test/bridge-relay.e2e-spec.ts` (server-side relay: no-bearer, no-deviceId, cross-workspace, oversized frame); `plugins/resolve/aksharo_core_app/server.py` (C09, in `main` as of this audit) adds a `?token=` query-string bearer fallback for its embedded-Chromium panel — reviewed, not fixed, see "T11 deviation" below                                                                                                                              |
| T12 | Pairing-code brute force / port squatting      | implemented+tested                                                                                                                | `packages/bridge-core/src/pairing.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T13 | Panel secret exposure                          | implemented, untested by this WP (no runtime harness for CEP panels in this repo — reviewed by design/code inspection only)       | `packages/bridge-core/src/keystore.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T14 | Loopback TLS trust                             | implemented+tested                                                                                                                | `packages/bridge-core/src/cert.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T15 | Licence key sharing / offline abuse            | implemented+tested                                                                                                                | `apps/api/test/b08-devices-licensing.e2e-spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T16 | Payment webhook spoofing / replay              | implemented+tested                                                                                                                | `apps/api/test/billing.e2e-spec.ts`, `apps/api/src/billing/providers/webhook-envelope.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T17 | Affiliate fraud                                | implemented+tested                                                                                                                | `apps/api/test/affiliates.e2e-spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T18 | Provider data leakage / retention              | implemented+tested (contractual controls out of code scope)                                                                       | `apps/api/src/insights` / `provider_submissions` registry — see module README                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T19 | Prompt injection via transcript content        | implemented+tested                                                                                                                | `apps/api/src/transcripts` Zod-validated LLM output schemas; see module tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T20 | Admin compromise                               | implemented+tested                                                                                                                | `apps/api/src/admin/admin.guard.ts` (kind:"admin" check, DB re-read of `admin_roles`, superadmin superset) + `apps/api/src/admin/admin.guard.test.ts` (non-admin-kind token 403'd, no-active-roles 403'd)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T21 | Secrets in code/logs                           | implemented+tested; **secret scan clean**                                                                                         | Local regex sweep (AWS keys, private-key blocks, `sk-`/`ghp_`/`xox`/`AIza` tokens, Postgres URLs with creds, generic `password/secret/api_key = "..."` assignments) over all tracked `.ts/.js/.json/.env/.py/.md/.yml/.sh/.ps1` files outside `node_modules`/build output: 53 hits, all in test fixtures (`correct-horse-battery-staple`, `test-callback-secret-...`, TOTP RFC-4226 test vector `JBSWY3DPEHPK3PXP`) or local dev creds (`montaj:montaj@localhost`, `.env.example`). No real credential found. `gitleaks` binary is not present in this environment (no network install attempted per "local tools only"); the regex sweep is the documented fallback the brief allows. |
| T22 | Local engine sidecar tampering                 | implemented, not independently re-verified this pass (native binary signing is a release-pipeline concern, see `docs/RELEASE.md`) | `apps/desktop` sidecar launcher, hash check — code inspection only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T23 | Denial of wallet (mass jobs)                   | implemented+tested                                                                                                                | `apps/api/src/jobs/admission.service.ts` + `.test.ts`; `apps/api/test/jobs.e2e-spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T24 | Data residency violation                       | implemented+tested                                                                                                                | `apps/api/src/common/storage/s3-object-store.ts` region pinning + `.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T25 | Desktop shell abuse                            | implemented, **dependency gap found** (see Automated checks below)                                                                | Electron hardening flags in `apps/desktop` main process; Playwright-Electron smoke referenced by THREAT-MODEL, not re-run in this WP (brief: "no Playwright")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## T11 deviation reviewed: C09's `?token=` query-parameter bearer fallback

`plugins/resolve/aksharo_core_app/server.py` (C09, merged into `main` after
this WP's worktree branched, then pulled in by this WP's `git merge main`)
added a second way to authenticate its loopback WebSocket: alongside the
`Authorization: Bearer <token>` header `bridge/client.py` sends, the server
now also accepts the same bearer as a `?token=` query parameter
(`_query_token`, `_handle_connection`), because the Studio panel is HTML/JS
hosted inside Resolve's embedded Chromium and the browser `WebSocket`
constructor cannot set request headers on the handshake — only a real
`websockets`-library client can. This is flagged in the file's own docstring
as a deviation, not silently introduced. This WP's file boundaries exclude
`plugins/resolve/**`, so nothing there was changed; this is a review only.

**Assessment, three questions:**

1. **Does the token end up in a log?** No logging call in `server.py` or
   `console.py` prints `connection.request.path` or anything derived from it
   — `console.py` only prints a static startup banner, and there is no
   access-log middleware here. The `websockets` library itself logs the
   handshake at `DEBUG` (its own `logging.getLogger("websockets.server")`),
   which is not enabled by anything in this repo's default configuration, so
   under the shipped configuration the token is not written to a file or the
   Resolve console. The risk is latent rather than realized: if anyone later
   adds request/access logging to this server (a common thing to reach for
   while debugging a stuck panel), the token would leak into whatever that
   logging targets — including, after C12 (just merged), a support-diagnostics
   bundle if such a log were ever picked up by it. **No evidence of a leak
   today; a plausible one if the code changes again without this in mind.**
2. **Does it need scrubbing from a log?** Not today (no log exists to scrub).
   Recommend a code comment at the point any future logging is added,
   flagging that `request.path` must be redacted past the `?` before it is
   logged — this is a documentation/process fix, not a code fix, since there
   is nothing to redact yet.
3. **Is a one-time WS ticket exchange the better control?** Yes, in
   principle: a short-lived, single-use ticket minted by an authenticated
   call (still needs _some_ channel — an HTTP `POST` from the panel's own
   `fetch`, which unlike `WebSocket` **can** set an `Authorization` header)
   would mean the long-lived discovery-file bearer never appears in a URL at
   all, only a value that is worthless after first use. This is a real
   improvement over the current fallback, but it is a protocol change to
   C09's own surface (a new endpoint, a ticket store, a TTL) — squarely
   outside this WP's `plugins/resolve/**`-excluded file boundary and larger
   than a "minimal fix."

**Severity: Low.** The whole surface is loopback-only (127.0.0.1), the token
is scoped to one Resolve session and stored in a 0600 discovery file, Origin
is not attacker-controllable from outside the local machine, and no logging
path exists today that would actually record the token. The realistic
exposure is browser devtools / history on the same machine already running
the paired Resolve session — a caller in a position to read that already
has the same access a compromised panel page would grant directly.

**Follow-up (not fixed here, file boundary excludes `plugins/resolve/**`):**
add a one-time WS ticket exchange (`POST` with `Authorization` header →
short-lived single-use ticket → `?ticket=` on the WebSocket URL) to replace
the raw bearer in the query string, and add an explicit "never log
`request.path` unredacted" comment at `_handle_connection` in the meantime.
Owner: C09 or a small dedicated follow-up WP before the query-token fallback
is relied upon in production, since it is currently the only place in the
repo where a long-lived bearer can appear in a URL.

**Update (C02c, 2026-09-03): fixed.** `plugins/resolve/aksharo_core_app/server.py`
no longer accepts `?token=` at all. `_process_request` (the `websockets`
library's opening-handshake hook) now intercepts a bodyless `GET
/session/ws-ticket` carrying `Authorization: Bearer <bearer>` before it
becomes a WebSocket handshake, and `_issue_ws_ticket` mints a 30-second,
single-use ticket (`secrets.token_urlsafe(32)`, popped from an in-memory dict
on first redemption or once expired) returned as JSON. The panel's `fetch()`
(`plugins/resolve-panel/src/rpc/wsTransport.ts`'s `requestWsTicket`) calls
that endpoint — unlike the `WebSocket` constructor, `fetch` _can_ set an
`Authorization` header — then opens the WebSocket with `?ticket=` instead of
the raw bearer; `_handle_connection`'s `_consume_ws_ticket` validates and
pops it. A leaked ticket (browser history, devtools network log — the same
exposure `?token=` had) is now worthless after one use or 30 seconds, where a
leaked `?token=` was the long-lived discovery-file bearer itself.

Deviation from this follow-up's own literal "`POST`": the `websockets`
library's request parser (`websockets.http11.Request.parse`) hard-rejects any
non-`GET` method or a request carrying a body before `process_request` ever
runs — the same lower-level constraint that forced C09's `?token=` fallback
in the first place. The ticket endpoint is therefore a bodyless `GET`, still
gated on the `Authorization` header, still on the one existing loopback port
(no second listener, no discovery-file schema change). Documented in
`server.py`'s module docstring; tests: `plugins/resolve/tests/test_server.py`
(bearer required, ticket issued/redeemed, single-use, TTL expiry, unknown
ticket rejected) and `plugins/resolve-panel/src/rpc/wsTransport.test.ts`
(`requestWsTicket`'s header, failure, and malformed-response paths).

## New gap found and fixed: T3 — device-code lookup had no rate limit

`GET /auth/device/code/:userCode` requires an authenticated session (correct
per T3's design) but carried **no `@RateLimit` decorator at all**, unlike its
siblings `POST code` (`deviceCodeIp`), `POST token` (`deviceTokenIp`), and
`POST approve` (`deviceApproveUser`). `RateLimitGuard` is a no-op when no rule
is attached (`apps/api/src/common/guards/rate-limit.guard.ts:80`: `if (rules
=== undefined || rules.length === 0) return true;`), so any signed-in account
could grind the 8-character user-code space (`BCDFGHJKLMNPQRSTVWXZ23456789`
alphabet, 4-4 groups) to enumerate other people's pending device grants and
read their host app / OS / IP / coarse location — an information-disclosure
angle on T3 the threat-model row does not explicitly call out but the same
mitigation family (per-caller rate limiting) covers.

**Severity: Medium** (requires an authenticated account; keyspace is large
enough that a real brute force is impractical, but there was truly zero
friction, and the leaked fields are the same ones T3 says must be gated).

**Fix:** added `deviceDescribeUser` to `apps/api/src/auth/auth.constants.ts`
(20 requests / 10 minutes, keyed on the caller) and `@RateLimit(...)` to the
route in `apps/api/src/auth/device.controller.ts`. New test:
`apps/api/test/auth.e2e-spec.ts` → "device code" → "rate-limits guessing at
the user-code lookup, even though it requires a session". All 55 tests in
`auth.e2e-spec.ts` pass with the fix.

## Automated checks

### `pnpm audit --audit-level=high`

58 findings (1 critical, 24 high, 27 moderate, 6 low) as of 2026-09-03. Every
finding is in a **build-time or desktop-packaging** dependency chain, not a
runtime API/web dependency reachable by an attacker over the network:

| Package                                                                                                                | Severity (max)                                                                                                         | Path                                                                                                                                                                        | Triage                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron`                                                                                                             | high (several: use-after-free x3, command-line switch injection, cross-origin protocol read, context-isolation bypass) | `apps/desktop` direct dep `^33.4.11`; fixes land at 38.8.6/39.x                                                                                                             | **Follow-up, not fixed here** (out of a minimal-fix WP: bumping Electron's major is a cross-cutting desktop change that needs its own regression pass across C00–C03, and the brief caps fixes at "minimal and tested"). Severity: **High**. Recommend a dedicated WP to bump `electron` to `>=39.8.10` before Gate C ships the desktop app, with the existing Electron-hardening tests (fuses, contextIsolation, navigation allowlist per T25) re-run. |
| `tar` (via `electron-builder`→`@electron/rebuild`→`node-gyp`)                                                          | critical (decompression DoS) + several high (path traversal/hardlink)                                                  | Windows-only build-time toolchain, never runs against untrusted input in production; still worth bumping when `electron-builder` next updates its own `tar` pin             | Low priority follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `postcss` (via `next@15.5.25`)                                                                                         | high (arbitrary `.map` file read via `sourceMappingURL`)                                                               | Next.js's own bundled build-time PostCSS; not reachable at runtime (no attacker-controlled CSS is ever compiled by this app)                                                | Documented, no action — will resolve itself on the next Next.js bump                                                                                                                                                                                                                                                                                                                                                                                    |
| `js-yaml` (via `gray-matter` in both `apps/api` and `apps/web`, and via `@cyclonedx/cyclonedx-npm` in `tools/release`) | high (quadratic-CPU DoS via YAML merge keys)                                                                           | `gray-matter` parses front-matter in Markdown content this app authors itself (academy/support articles), not third-party YAML; `cyclonedx-npm` is a release-time SBOM tool | Low priority — no attacker-supplied YAML reaches either path today                                                                                                                                                                                                                                                                                                                                                                                      |
| `@cyclonedx/cyclonedx-npm`                                                                                             | high (shell injection via `--workspace` arg)                                                                           | `tools/release` invokes it with a fixed argument list, no user input                                                                                                        | Not exploitable as used; follow-up bump when convenient                                                                                                                                                                                                                                                                                                                                                                                                 |
| `deepmerge-ts` (via `prisma`'s own config loader)                                                                      | high (stack exhaustion)                                                                                                | Dev-time CLI only                                                                                                                                                           | No action                                                                                                                                                                                                                                                                                                                                                                                                                                               |

None of these are fixed in this WP: all are transitive, none are on a path an
external attacker can drive with request data, and several require a
cross-cutting version bump the brief's "minimal fixes" boundary does not
cover. All are listed here with severity for the pentest hand-off and a
follow-up ticket, per the brief's "larger items go into the audit doc".

**Update (C02c, 2026-09-03): `electron` row fixed.** `apps/desktop`'s
`electron` is bumped `^33.4.11` → `^44.1.1` (latest stable major at the time,
past the recommended `>=39.8.10` floor), with `electron-updater` → `^6.8.9`,
`electron-builder` → `^26.15.3` and `@electron/fuses` → `^2.1.3` for
compatibility. Fuses re-verified (`scripts/after-pack.cjs` unchanged, `pnpm
pack:dry` green — RunAsNode off, cookie encryption on, ASAR integrity on),
`apps/desktop`'s full vitest suite green (83 tests, unchanged behaviour), and
the Playwright-Electron smoke (`e2e/smoke.spec.ts`) run once locally: launch,
offline-page render, and preload-API-surface assertions all pass. `pnpm
audit --audit-level=high`'s `electron` finding is gone at this version as of
2026-09-03; the other rows in this table (`tar`, `postcss`, `js-yaml`,
`@cyclonedx/cyclonedx-npm`, `deepmerge-ts`) are unchanged and still open
follow-ups, out of this WP's scope.

### `pip-audit`

`apps/worker-ai/requirements.lock` and `apps/model-server/requirements.lock`:
**no known vulnerabilities**. Dev-lock files for both also clean.
`apps/model-server/requirements-gpu.lock` (torch + CUDA stack) was not
completed — `pip-audit` timed out after 3 minutes resolving its large
dependency graph; it is a GPU-only, non-Windows-host lockfile not installed
in this sandbox and is flagged as **not verified this pass** rather than
clean.

### Secret scan

See T21 above — clean, no real secrets found.

### ESLint security rules

No `eslint-plugin-security` (or equivalent) is configured in
`eslint.config.mjs`. This is a real gap but adding and tuning a new lint
plugin repo-wide is out of this WP's minimal-fix boundary (`eslint.config.mjs`
is not in the WP's file boundaries either — only `.github/workflows/ci.yml`
is). **Follow-up, Low/Medium severity**: add `eslint-plugin-security` (or the
`@typescript-eslint` equivalents already partially covering `no-eval`
etc.) scoped to `apps/api/src` in a dedicated WP.

**Update (C02c, 2026-09-03): fixed, repo-wide.** `eslint-plugin-security`'s
`recommended` ruleset is wired into `packages/config/eslint.config.base.mjs`
(every workspace, at `warn`, since findings elsewhere haven't been reviewed
by this WP). Every finding across `apps/api`, `apps/web`,
`packages/bridge-core` and `apps/desktop` (the packages this WP could touch)
was fixed or annotated: one real ReDoS-shaped regex fixed
(`apps/api/src/media/import/subtitle-parsers.ts`'s WebVTT voice-tag pattern,
parsing attacker-controlled subtitle uploads — timed before/after against a
50k-character adversarial input); every other warning (401 total before this
pass: 215 in `apps/api`, 132 in `apps/web`, 39 in `packages/bridge-core`, 15
in `apps/desktop`) reviewed and annotated in place as a false positive
(bracket access on a typed/enumerated key, a path built from internal
non-attacker-controlled segments, a sentinel comparison rather than a secret,
or a bounded/disjoint regex the plugin's static heuristic over-flags — each
timed against adversarial input where the shape was plausible). With the
count at zero, those four packages' own `eslint.config.mjs` promote the
ruleset to `error` (`securityRulesStrict` export); every other package stays
at the shared `warn` default until its own findings get the same review.
`pnpm lint` is green repo-wide (`turbo run lint`, 43/43 tasks).

### CSP / security headers

**Gap found and fixed.** Neither `apps/web/next.config.ts` nor
`apps/web/middleware.ts` set any security response header (no CSP, no HSTS,
no `X-Frame-Options`/`frame-ancestors`, no `Referrer-Policy`) before this
change, and `apps/api/src/main.ts` never installed `helmet` or any equivalent.
**Severity: High** for the web app (a public-facing Next.js app with no
`frame-ancestors` is clickjackable; no HSTS means a stripped-TLS first visit
is possible) — closed in this WP.

**Fix (web):** `apps/web/next.config.ts` gained a `headers()` function
applying CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src
'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`),
HSTS (180 days + subdomains), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
and a conservative `Permissions-Policy`. Test:
`apps/web/next.config.test.ts` (added to `vitest.config.ts`'s `include`).

CSP uses `'unsafe-inline'` for `script-src`/`style-src` rather than a
nonce — Next.js's own hydration inlining has no nonce plumbing in this repo
yet, and adding one is a larger, separate change. **Follow-up, Medium
severity**: move to nonce-based CSP once Next's nonce support is wired
through `middleware.ts`.

**Fix (API):** `apps/api/src/main.ts` now calls `helmet()` with CSP disabled
(Swagger UI at `/docs` is server-rendered HTML with inline scripts a strict
API-wide CSP would break — HTML CSP is the web app's job, not the JSON API's)
but HSTS, `frameguard: deny`, `no-referrer`, and every other helmet default
(no-sniff, hide `X-Powered-By`, etc.) applied. No test added at the API layer
beyond the existing e2e suites passing unchanged with the middleware in
place — a dedicated header-assertion test was judged lower value than the web
one since the API serves no HTML except `/docs`, which is explicitly exempted.

## Manual review notes (JWT `kind` confusion matrix)

Reviewed `apps/api/src/common/guards/jwt-auth.guard.ts`,
`apps/api/src/admin/admin.guard.ts`, and `apps/api/src/common/guards/api-key.guard.ts`
against every claimed confusion in the brief:

- **API key → `/admin`**: architecturally impossible, not merely
  guarded-against — `/admin/**` routes wear `AdminGuard` (which wraps
  `JwtAuthGuard` and additionally requires `kind === "admin"`), and
  `ApiKeyGuard` is a wholly separate guard applied only to `public-api/v1`
  routes; an `X-Api-Key` header is never read by `AdminGuard`/`JwtAuthGuard`
  at all. No test needed to demonstrate a guard that is never invoked.
- **Bridge token → user routes**: `JwtAuthGuard` explicitly 403s a
  `kind: "bridge"` claim on any route not marked `@AllowBridgeToken()`
  (`jwt-auth.guard.ts:60-74`); tested in `apps/api/src/common/guards/guards.test.ts`.
- **Desktop token → `/v1` (public-api)**: `public-api/v1` routes use
  `ApiKeyGuard`, not `JwtAuthGuard` — a desktop session's bearer JWT is not
  even the credential type those routes read (`X-Api-Key` header only), so
  this confusion is likewise structurally excluded rather than merely tested.
  Confirmed by reading every controller under `apps/api/src/public-api/v1`.

No fix needed here — the design already prevents these by using disjoint
guards per credential kind rather than a single guard branching on `kind`.

## Proposed `docs/THREAT-MODEL.md` row updates (not applied — file is read-only for X01)

- Add a sub-bullet to T3's mitigation column: "device-lookup rate limit
  (`GET /auth/device/code/:userCode`, `deviceDescribeUser` bucket, added
  2026-09-03 after X01 found it missing)".
- Add a note to the "Checklists consumed by work packages" section: "X01
  (2026-09-03): re-verified all rows; found and fixed T3 rate-limit gap and
  the web/API security-header gap (not itself a numbered threat row — folds
  into T21's "secrets/hardening" spirit and T11's header-based CSRF/clickjack
  defenses); electron dependency bump recommended before Gate C ships desktop."
