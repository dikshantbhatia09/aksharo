# @montaj/web

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4. One codebase for
the marketing site and the studio, split by route group.

**Status:** A13 — the app shell, the auth screens, onboarding, settings and the
client layer. A14–A17 fill in Home, Projects and the editor; A24 the marketing
site.

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
   `/settings`, `/onboarding` and `/device` before any HTML is sent — a routing
   decision, not an authorisation one. The shell still rotates on mount, because
   a cookie is not proof the family is alive.

## Configuration

Read on the server at request time (`lib/runtime-config.ts`), not inlined as
`NEXT_PUBLIC_*`, so one build runs in every environment: `API_ORIGIN`,
`POSTHOG_KEY`, `POSTHOG_HOST`, `SENTRY_DSN`, `FEATURE_FLAGS_JSON`.

Feature flags this app reads from `FEATURE_FLAGS_JSON` (CONTRACTS §1):

| Flag                  | Default | Effect                                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| `growth.streakWidget` | off     | Shows the streak badge on the credit meter (B06's experiment).                       |
| `realtime.enabled`    | off     | Opens the shell's WebSocket. **Off until A08's Redis fan-out is fixed** — see below. |

> `RedisRealtimeBus` duplicates a connection created with `lazyConnect: true` and
> `enableOfflineQueue: false`, so the duplicate is never dialled and the first
> `SUBSCRIBE` rejects with "Stream isn't writeable", taking the API process down.
> A08's suite only exercises the in-memory bus, so nothing caught it until a
> browser actually joined a room.

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
`auth:signup:ip` halfway through.

`/ui-kit`, the auth screens, the shell, onboarding and every settings screen are
screenshotted into `e2e/__screenshots__/` (gitignored — they are review
artefacts) and checked with axe; serious and critical violations fail.

## Notes

- `@montaj/ui` and `@montaj/api-client` are in `transpilePackages`: the first
  ships source with `"use client"` boundaries, and the second would otherwise be
  required as CommonJS on the server while the app imports the ESM build of
  TanStack Query — two `QueryClient` contexts and a very confusing error.
- `next-env.d.ts` is committed, unlike the Next.js default, so `tsc --noEmit`
  works before a build has ever run.
- `eslint.ignoreDuringBuilds` is on because linting is its own turbo task using
  the shared flat config; the build must not run a second, different pass.
