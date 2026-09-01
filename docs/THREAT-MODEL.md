# THREAT-MODEL.md — Montaj (X06, authored by Fable 5.1)

## Assets
User media and transcripts (personal data, client footage under NDA); account credentials and sessions; credits and money (ledger, mandates, payouts); licence keys and device leases; signed render manifests (revenue enforcement); provider API keys and callback secrets; the local bridge's control surface (can spend credits, mutate projects, run local jobs); admin console.

## Actors
Anonymous web visitor; authenticated user; workspace member with lower role; malicious web page in the user's browser; malicious local process on the user's machine; hostile network (DNS rebinding, MITM on loopback); compromised worker or provider; affiliate fraudster; insider with admin access.

## Trust boundaries
1. Browser ↔ API (public internet). 2. Bridge ↔ panels/web (loopback and relay). 3. API ↔ workers ↔ providers (internal network + vendor APIs). 4. Payment provider ↔ API (webhooks). 5. Admin ↔ API. 6. Desktop app ↔ local engine (sidecar IPC).

## Threats and mitigations (owner WP)
| # | Threat | Mitigation | Owner |
|---|---|---|---|
| T1 | Credential stuffing / weak passwords | argon2id, rate limits per IP+account, breached-password check, optional MFA later | A04 |
| T2 | Refresh-token theft/replay | Token families, rotation with 60 s grace, reuse detection revokes the family, device-bound sessions listable | A04 |
| T3 | Device-code phishing (attacker starts a flow, victim approves) | 8-char unambiguous user code, ≤ 10-min TTL, per-IP rate limits, pending-code cap, approval screen shows host app, device, OS, approximate location; approval requires an authenticated web session | A04 |
| T4 | Tenant confusion via workspace header | Workspace bound into the JWT; switch only via token exchange; membership guard on every route; contract test per route | A04, A05 |
| T5 | IDOR on project/media/export ids | ULIDs + ownership checks in guards; no list endpoints across workspaces; signed short-lived download URLs | A06, A21 |
| T6 | SSRF via user-supplied URLs (import, public API, webhooks) | Resolve first, deny RFC1918/loopback/link-local/169.254.169.254/IPv6 ULA, pin resolved IP, cap redirects/size/time, egress-restricted client | A06, B14 |
| T7 | Malicious uploads (fonts, zips, media) | Content-type + size limits on presigned uploads, font sanitisation/subsetting, zip scanning, ffprobe sandboxing with timeouts | A06, A07, A18b |
| T8 | Callback forgery / replay (worker → API) | HMAC over timestamp + body, 5-min skew window, `(jobId, attemptId)` idempotency, settlement CAS on hold status | A08 |
| T9 | Credit double-spend / race | Single-statement conditional reserve with RETURNING, one hold per job, property test in DoD | A08, B02 |
| T10 | Watermark/entitlement bypass in browser export | Server-signed manifest with nonce/expiry/watermark/caps; unwatermarked path not shipped to unentitled workspaces; accept residual bundle-patching risk | A19, A21 |
| T11 | Local bridge abused by a hostile web page (DNS rebinding, CSRF) | Bearer token on every route incl. `/status`; `Host` ∈ {127.0.0.1, localhost}:port; `Origin` allow-list; preflight-forcing header; no cookies; relay-first transport | C01 |
| T12 | Pairing-code brute force / port squatting | Tray-gesture pairing; 8-char base32 single-use 60 s code, 5 attempts then 15-min lockout; discovery file 0600 with token; fixed ladder only for UXP manifest, token still required | C01 |
| T13 | Panel secret exposure (CEP is Chromium 99) | Panels hold tokens in memory only; bridge holds credentials; 12 h scoped pair tokens | C01, C05a/b |
| T14 | Loopback TLS trust | Per-install certificate trusted at install; private key in OS keychain/DPAPI; regenerated on reinstall | C01, C02 |
| T15 | Licence key sharing / offline abuse | Keys bound to workspace with activation limits; 7-day offline window; heartbeat nonce; revocation list applied on contact | B08, C11 |
| T16 | Payment webhook spoofing / replay | Razorpay signature verification, idempotency by event id, amount/currency cross-check against the order | B01 |
| T17 | Affiliate fraud (self-referral, coupon sites, fake conversions) | Device/IP/payment fingerprints, 30-day maturation hold, clawback on refund, code revocation, manual approval | B07 |
| T18 | Provider data leakage / retention | DPAs with zero-retention + no-training terms; `provider_submissions` registry; region-pinned endpoints; transcripts passed as data to LLMs | A10, B11, B16 |
| T19 | Prompt injection via transcript content | Delimited data blocks, explicit instructions, Zod-validated outputs, no tool execution from LLM output | B11, D07 |
| T20 | Admin compromise | Separate admin app/guard, MFA required, audit log, least-privilege roles, IP allow-list optional | B13 |
| T21 | Secrets in code/logs | KMS-managed env, log redaction, secret scanning in CI | A01, A03 |
| T22 | Local engine sidecar tampering | Signed binaries, version pinning, hash check on launch, localhost-only IPC with token | C03a |
| T23 | Denial of wallet (mass jobs) | Per-workspace enqueued-credit cap, max queue wait, 429 admission control, free-tier daily caps | A08 |
| T24 | Data residency violation | Raw media + DB in ap-south-1; derived objects on R2 APAC hint; sub-processor list; region pinned per workspace | A06, X05 |

## Checklists consumed by work packages
- **A04:** T1–T4. **A06/A07:** T5–T7, T24. **A08:** T8, T9, T23. **A19/A21:** T10. **B01/B02:** T9, T16. **B07:** T17. **B08/C11:** T15. **C01:** T11–T14. **C03a:** T22. **B11/D07:** T19. **B13:** T20. **A01/A03/X05:** T21, T24.
- X01 (security review before Gate C) re-verifies every row with tests or manual evidence.
