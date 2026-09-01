# `auth` — sign-in, sessions and the device grant (A04)

Everything that turns a person into an `AuthPrincipal`: email and password, Google
with PKCE, magic links, refresh-token families, the RFC 8628 device grant,
workspace token exchange and session management.

Design references: `docs/CONTRACTS.md` §5 and §8, `docs/THREAT-MODEL.md` T1–T4,
`03-architecture/05-system-architecture.md` §8, `07-api-and-contracts.md` §Auth,
`12-redesign-decisions.md` D27 and D60.

## Endpoints

| Method   | Path                           | Auth   | Notes                                                             |
| -------- | ------------------------------ | ------ | ----------------------------------------------------------------- |
| `POST`   | `/auth/signup`                 | public | 202 always — see [Enumeration](#enumeration). Age-gated (D60).    |
| `POST`   | `/auth/verify-email`           | public | Single-use token, 24 h.                                           |
| `POST`   | `/auth/login`                  | public | One message for every failure.                                    |
| `POST`   | `/auth/magic-link`             | public | 202 always. Token single-use, 15 min.                             |
| `POST`   | `/auth/magic-link/consume`     | public | Signs in and confirms the address.                                |
| `POST`   | `/auth/refresh`                | public | Rotation with a 60 s grace; reuse revokes the family.             |
| `POST`   | `/auth/logout`                 | public | Takes the refresh token; 204 whatever happens.                    |
| `POST`   | `/auth/token/exchange`         | bearer | Switch workspace. Re-checks membership, mints a new session.      |
| `GET`    | `/auth/sessions`               | bearer | Live sessions, the caller's marked `current`.                     |
| `DELETE` | `/auth/sessions/{sessionId}`   | bearer | Revokes the family. Somebody else's session is a 404.             |
| `POST`   | `/auth/parental-waitlist`      | public | Offered to a sign-up the age gate blocked.                        |
| `GET`    | `/auth/oauth/google/start`     | public | 302 to Google. `?client=web\|desktop\|bridge`.                    |
| `GET`    | `/auth/oauth/google/callback`  | public | 302 onward with a single-use handoff code.                        |
| `GET`    | `/auth/desktop-landing`        | public | https page that triggers `aksharo://auth-callback`.               |
| `POST`   | `/auth/oauth/complete`         | public | Exchanges the handoff code. Needs a date of birth for a new user. |
| `POST`   | `/auth/device/code`            | public | 8-character user code, 10 min, poll every 5 s.                    |
| `POST`   | `/auth/device/token`           | public | Polling: `authorization_pending`, `slow_down`, `expired_token`, … |
| `GET`    | `/auth/device/code/{userCode}` | bearer | The approval screen's data.                                       |
| `POST`   | `/auth/device/approve`         | bearer | `{userCode, workspaceId?, decision?}`.                            |

## Tokens

**Access token** — RS256 JWT, 15 minutes, claims `{sub, ws, role, kind, jti, iat, exp}`
(CONTRACTS §5) plus the registered `iss`, which pins the deployment so a staging
token cannot be spent in production. `jti` **is the session id**: access tokens are
never revoked individually (families are), so the useful thing for the claim to
name is the session that minted it — it correlates audit rows and marks the
caller's own entry in `GET /auth/sessions`.

Signed and verified with `node:crypto` rather than a JWT library. The algorithm is
compared against the literal `"RS256"` _before_ the signature is checked, so `alg:
none` and HMAC confusion have no path through the verifier.

**Refresh token** — 32 random bytes, base64url, stored only as `sha256`. One
`sessions` row is one family:

```
refresh_token_hash   the token that works now
previous_hash        the token it replaced
rotated_at           when that happened
```

A presented token is in exactly one of four states:

| State                                            | Result                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| matches `refresh_token_hash`                     | rotate; issue a new pair                       |
| matches `previous_hash`, `rotated_at` < 60 s ago | replay the **same** pair the rotation produced |
| matches `previous_hash`, `rotated_at` ≥ 60 s ago | reuse: revoke the family, audit, 401           |
| matches nothing                                  | 401                                            |

The grace exists because clients lose responses — a flaky mobile network, two
tabs racing. Replaying the identical pair (cached in Redis for 60 s under the
spent token's hash) means the client ends up holding exactly one live token
instead of two. The rotation itself is a conditional `UPDATE ... WHERE
refresh_token_hash = :spent`, so concurrent refreshes cannot both win.

Families live 30 days from issue and are **not** extended by rotation.

## Enumeration

`POST /auth/signup` answers `202 {status: "verification_sent"}` whether or not the
address already has an account, and `POST /auth/magic-link` answers `202` whether
or not it exists. A registration form that says "that email is taken" is a free
account checker, and a verified list of customer addresses is the input to
credential stuffing. The mail that arrives differs; only the mailbox owner sees
which. Login answers `auth/invalid_credentials` for an unknown address and a wrong
password alike, and pays the same argon2 cost either way.

## Rate limits

Token buckets in Redis (`montaj:rl:<bucket>:<subject>`), evaluated by one Lua
script so concurrent requests on different instances cannot each read-modify-write
past the limit. Exhaustion is `429 common/rate_limited` with `Retry-After`.

| Bucket                     | Keyed on | Allowance    |
| -------------------------- | -------- | ------------ |
| `auth:signup:ip`           | address  | 10 / 10 min  |
| `auth:login:ip`            | address  | 20 / 5 min   |
| `auth:login:account`       | email    | 10 / 15 min  |
| `auth:magic:ip`            | address  | 5 / 10 min   |
| `auth:magic:account`       | email    | 3 / 15 min   |
| `auth:verify:ip`           | address  | 20 / 10 min  |
| `auth:refresh:ip`          | address  | 60 / min     |
| `auth:exchange:user`       | user     | 30 / min     |
| `auth:device:code:ip`      | address  | 10 / 10 min  |
| `auth:device:token:ip`     | address  | 120 / 10 min |
| `auth:device:approve:user` | user     | 20 / 10 min  |
| `auth:oauth:start:ip`      | address  | 20 / 10 min  |
| `auth:waitlist:ip`         | address  | 5 / hour     |

The email subject is hashed before it becomes part of a key: an address is
personal data and Redis keys reach slow-log output. The limiter **fails open** —
a Redis outage must not lock every user out — and says so in the log.

The address itself comes from the socket unless `TRUST_PROXY=1` says an edge you
control rewrites `X-Forwarded-For`. Trusting that header unconditionally would
hand every attacker a fresh bucket per request.

## The age gate (D60)

Sign-up requires `dateOfBirth` and `jurisdiction`. India blocks under-18s and the
EU blocks under-16s with `403 auth/age_restricted` and a pointer to
`POST /auth/parental-waitlist`; anyone under 18 anywhere is stored as
`ageBracket: minor`, because D60 also switches analytics, streaks, referral and
affiliate targeting off for declared minors. Google sign-up is gated too: the
provider supplies no date of birth, so a new Google identity comes back from the
callback as `status=registration` and the account is only created once
`POST /auth/oauth/complete` carries one.

Consent is captured per purpose into `consent_records` — `analytics`, `memory`,
`marketing`, all default false — and a **refusal is written as a row**, because
the notice-and-choice record has to show what was asked as well as what was agreed.

## Threat-model coverage (T1–T4)

| Row                                         | Control                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** Credential stuffing / weak passwords | argon2id (64 MiB, t=3, p=1); per-IP **and** per-account buckets; breached-password check over HIBP k-anonymity (flagged, fail-open); generic errors and constant-cost verification; no address enumeration                                                                                                                         | `password.service.test.ts`, `breached-password.service.test.ts`, `auth.e2e-spec.ts` › _rate limits_, › _answers an unknown address and a wrong password identically_ |
| **T2** Refresh-token theft / replay         | Families, rotation with a 60 s grace, reuse revokes the family and writes `auth.refresh.reuse_detected`, sessions listable and revocable, tokens stored hashed                                                                                                                                                                     | `auth.e2e-spec.ts` › _refresh rotation and reuse detection_, › _sessions_                                                                                            |
| **T3** Device-code phishing                 | 8 characters from a 28-symbol unambiguous alphabet, 10-minute TTL, per-IP bucket **and** a cap of 5 pending flows per address, server-enforced 5 s poll interval, approval screen naming host app, device, address and coarse location, approval requires an authenticated web session, device code stored hashed, redeemable once | `auth.e2e-spec.ts` › _device code_, `tokens.test.ts`, `geo.test.ts`                                                                                                  |
| **T4** Tenant confusion via a header        | The workspace lives in the `ws` claim only; `X-Workspace-Id` is never read; `token/exchange` re-checks membership; every rotation re-reads the membership so a demotion bites within one token lifetime; device approval re-checks the approver's membership                                                                       | `auth.e2e-spec.ts` › _guards_ › _ignores a workspace supplied in a header_, › _token exchange_, `guards.test.ts`                                                     |

Secondary controls this module also carries: OAuth state and PKCE verifier are
single-use Redis entries (a callback the API did not start has no state, so CSRF
on the callback has no purchase); tokens never travel in a redirect URL, only a
single-use handoff code does; a Google identity is linked to an existing account
only when the provider says the address is verified.

## Feature flags

Read from `FEATURE_FLAGS_JSON` (CONTRACTS §1), not from new variables:

| Key                          | Default | Effect                                    |
| ---------------------------- | ------- | ----------------------------------------- |
| `auth.breachedPasswordCheck` | `false` | Enables the HIBP range lookup on sign-up. |

## What A04 does not do

MFA, password reset, licence keys (B08) and API-key issuance (B14). `ApiKeyGuard`
ships now because the key format and the scope check are what B14 has to build
against, but no route wears it yet.

## Open questions for the orchestrator

1. **Mail delivery.** There is no mail provider in CONTRACTS §1 and no `notify`
   consumer until A08, so `AuthMailerService` logs the message and, outside
   production, pushes it onto a Redis list the e2e suite reads. In production it
   logs a warning and delivers nothing. A08 or B12 needs to own real delivery
   before anyone can verify an address on a deployed environment.
2. **Parental waitlist storage.** `06-data-model.md` has no table for it, and the
   Prisma schema is frozen outside A03, so entries live in the Redis hash
   `montaj:auth:parental-waitlist` keyed by `sha256(email)`. A durable table
   belongs with the parental-consent flow itself (due before May 2027).
3. **Coarse geo.** Only what an edge already resolved (`cf-ipcountry` and
   friends) is available; there is no geo-IP database and no environment variable
   for one. The approval screen says "unknown" rather than guessing.
4. **API-key format.** `ApiKeyGuard` assumes `<prefix>.<secret>` with the prefix
   stored in clear and `sha256(secret)` in `api_keys.hash`. B14 must mint keys in
   that shape or raise an ADR.
