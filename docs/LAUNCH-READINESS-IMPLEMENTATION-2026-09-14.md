# Launch-readiness implementation record — 14 September 2026

Companion to `docs/PRODUCTION-LAUNCH-READINESS-2026-09-14.md`. That document is
the audit; this one records what was **changed in this repository** in response
to it, what was deliberately not changed, and what cannot be closed by a code
change at all.

Read the audit's own warning first and keep it: *"The incident commander changes
a cell only when the evidence artifact exists."* Nothing below turns a red cell
green. Code that makes a control possible is not evidence that the control
works; the evidence is a test result from staging at the exact release digest.

---

## 1. The finding the audit did not have

**Cloud video export was completely broken, in a way every test suite passed
through.**

`packages/caption-styles/src/naming.ts` imported `naming/denylist.json` with
TypeScript's `resolveJsonModule`. That is fine for the CommonJS build and emits
a bare `import ... from "./naming/denylist.json"` into `dist/esm` — which real
ESM refuses without `with { type: "json" }`. Node rejected the module, so every
rasteriser worker thread died on startup:

```
RasterPoolError: a rasteriser worker could not start: Module
".../caption-styles/dist/esm/naming/denylist.json" needs an import attribute of
"type: json"
```

`apps/render` draws every caption frame on those threads. The package's own
tests passed because they exercise the CommonJS build; six of `apps/render`'s
tests were failing and had been attributed to environment noise.

Fixed by making the deny-list a typed TypeScript module
(`src/naming/denylist.ts`) rather than JSON: identical data, no import attribute
needed, works under CommonJS, ESM and every bundler. `apps/render` now passes
293/293.

The generalisable point: **a dual-build package needs at least one test that
loads the ESM output the way production loads it.** Neither build is a proxy for
the other.

---

## 2. Closed in code

Each row is a change plus the test that pins it. "Closed" means the defect is
fixed and covered; it does **not** mean the audit's gate is green, which needs
staging evidence.

| Audit item | What was wrong | What changed |
| --- | --- | --- |
| P0-12 (brand) | `packages/config/src/brand.ts` carried a **competitor's** name, domain, deep-link scheme and support address — `Kalakar` / `kalakar.io` — introduced by commit `0be69d36`. The built `dist/`, which is what every app imports, carried it too. | Restored to Aksharo (decision D59). Added `FORBIDDEN_BRAND_NAMES` and a test that fails if a non-brand name ever reappears in `BRAND` or `PLUGIN_IDS`. Rebuilt `packages/config/dist`. |
| P0-07 (no Free entitlement) | Sign-up created user, workspace, membership and consent — and stopped. No subscription, no credit account, no grant. Upload worked; transcription silently never started. | `apps/api/src/users/free-entitlement.ts` provisions the Free subscription, credit account, grant lot and ledger row **inside the sign-up transaction**, for both email and Google. Idempotent, fails closed when the plan seed is missing. 7 tests. |
| P0-06 (logout) | The sign-out button called `POST /auth/logout` with `refreshToken: ""`, which the API rejects as too short, swallowed the error, and cleared only the cookie. The family stayed live for 30 days. | New same-origin BFF route `POST /api/session/logout` reads the httpOnly cookie, revokes upstream, and drops the cookie in every outcome. Reports `revoked: false` rather than implying a clean sign-out. 9 tests. |
| P0-06 (password policy) | 10-character minimum; compromised-password screening **off** unless a flag turned it on, and the live environment's `FEATURE_FLAGS_JSON` is `{}`. | Minimum raised to 15 (NIST SP 800-63B-4 single-factor). HIBP check now defaults **on**. New local blocklist (`common-passwords.ts`) as a bounded floor under the network check. Web copy aligned. 8 tests. |
| P0-06/12/13 (prod defaults) | `MAIL_PROVIDER=dev`, `LLM_PROVIDER=mock`, fake billing and empty Sentry were all silently acceptable in production. | `productionProblems()` in `packages/config/src/env.ts` refuses to boot on each, plus checkout without live Razorpay keys and the partner catalogue while its licence snapshots are unwritten. Error tracking is opt-out-with-a-flag, not opt-in-by-forgetting. 7 tests. |
| P0-08 (client identity) | `TRUST_PROXY=1` read the **left-most** `X-Forwarded-For` value — attacker-supplied. A forged prefix minted a fresh rate-limit bucket per request. | `TRUST_PROXY` is now a hop **count**, read from the right. A forged prefix of any length cannot shift the answer; a chain shorter than the configured hops falls back to the socket. 5 tests. |
| P0-08 (fail-open limiter) | Redis loss removed rate limiting entirely — unlimited sign-up, login and job admission during a dependency incident. | Degrades to a per-replica token bucket at 50% capacity with a bounded subject map, and logs the transition once. 5 tests. |
| P0-03 (fake roles) | Helm started the API with `--role=realtime` / `--role=scheduler`; `main.ts` never parsed the flag. All three booted the full app on the wrong port; the realtime Service pointed at a closed port. | `parseRole()` refuses an unimplemented role. Both components disabled in the chart with the reasoning recorded; the API serves `/realtime` itself and BullMQ repeatable jobs already guarantee one scheduler execution per tick. 5 tests. |
| P0-03 (routing/probes/ports) | Ingress routed `/ws`, protocol is `/realtime`. Readiness probed `/health` (liveness), so a pod with a dead database took traffic. AI worker Service declared 8000; the image binds 8091. | All three corrected in `values.yaml`. |
| P0-03 (migrations) | The runbook ran `node dist/scripts/migrate.js`, which is never emitted. The Docker `migrate` stage ran Prisma migrations + the **whole** seed, skipping `prisma/sql` and seeding a funded demo admin. | `migrate` stage runs `db:migrate` (schema **and** hand-SQL) then `db:seed:reference`. Seed split so `seedDemoWorkspace` refuses under `NODE_ENV=production`. Runbook corrected with why. |
| P0-04 (autoscaling) | KEDA watched the Redis list `bull:<queue>:wait`. Every job carries a priority, so BullMQ stores it in the `prioritized` **sorted set** — the list was near-permanently empty while the real backlog grew. Workers would not have scaled at all. | New `montaj_queue_depth{queue,state}` gauge sampled every 15 s; ScaledObjects switched to a Prometheus scaler on `waiting + prioritized`. Also fixes two shipped alert rules that queried this series, which nothing emitted. 5 tests. |
| P0-09 (secret blast radius) | One ExternalSecret carried the entire contract; every component mounted it. A compromised web pod held the DB URL, JWT signing key, Razorpay live keys, OAuth client secret, mail credentials and every provider key. | Per-component ExternalSecrets: a shared boot contract plus each component's own list. Web now holds no payment, identity, mail or provider credential. New `workload-irsa` Terraform module creates one IAM role per workload, trust-scoped to its exact service account. S3 clients omit `credentials` when static keys are blank so the default chain (IRSA) works. |
| P0-10 (inert policy) | The chart emits NetworkPolicy objects; the VPC CNI addon had no configuration, and it ignores NetworkPolicy unless told not to. Policies existed, were listed, and filtered nothing. | `enableNetworkPolicy: "true"` on the addon, on by default, with a variable to turn it off deliberately. Namespace template labels PSA `restricted` (enforce + audit + warn, version-pinned). |
| P0-10 (storage readiness) | Readiness did an **unauthenticated** `HEAD` and counted 403 as "up" — it passed with no credentials, wrong credentials, a read-only role, or the derived store unreachable. | Boot-time canary writes, reads back, verifies and deletes an object on **both** stores; a failure keeps readiness down for the process's life. Per-probe check is now a signed `head`. 14 tests. |
| P0-11 (connections) | No explicit pool budget; Prisma defaults to `numCpus * 2 + 1`, making fleet-wide connection use a property of node size and discoverable only by exhausting the database. | `DATABASE_POOL_SIZE` per process, applied in `PrismaService` and logged at boot. Worksheet in `docs/runbooks/db-connection-budget.md`. 7 tests. |
| P0-13 (recon surface) | Swagger UI and `/docs-json` always mounted, unauthenticated. | Disabled under `NODE_ENV=production` unless `API_DOCS_ENABLED=1`; also blocked at the edge along with `/internal/*`. |
| P0-08 (edge) | Proxied DNS and nothing else: no WAF rule, no bot control, no endpoint rate limit, no challenge. | `infra/terraform/modules/dns-cdn/waf.tf` adds managed + OWASP rulesets, rate limits on auth / job-creation / share-viewer, admin and docs lockdown, and a Turnstile widget. Off by default (`manage_waf`), because it needs a real zone on a paid plan. |
| P0-02 (CI) | `bridge-sea` built a workspace absent from this Git HEAD, failing before the gates that matter. Dependency audit was `|| true` on everything. | Stale job removed with the reasoning recorded. Audit split: **blocking** on `--prod`, reporting on the rest. |
| P0-12 (dead surfaces) | Marketing nav offered Plugins and Download; the sidebar offered "Get the desktop app". None of those products are in this Git HEAD. | `content/site/launch-surfaces.ts` is one matrix, everything off by default; nav and sidebar filter through it. 12 tests. |
| P0-05 (capacity) | The harness measured job admission only, and the report presented a bare PASS/FAIL that reads like a capacity result. | `LOAD_CONCURRENCY` added so a fixed per-request cost can be told from queueing; every report now prints what it did **not** measure. |

### Dependency remediation

`pnpm audit --prod --audit-level=high` reported **9 high findings**. Overrides
for `multer`, `postcss` and `js-yaml` (pinned inside 3.x — a bare `>=3.15.2`
resolves to 4.x, which removed `safeLoad` and broke `gray-matter`) took it to
**one**: `deepmerge-ts`, reachable only through the Prisma CLI.

That one is registered in `security/audit-exceptions.json` with a reason, an
expiry and an owner field, and `scripts/check-audit-exceptions.mjs` fails the
build when an exception is expired, undocumented or unowned.

**It is failing right now, deliberately:** the owner field says `TODO`. A named
human has to accept that finding before CI is green. That is the gate working,
not a defect.

---

## 3. Fixed along the way (pre-existing, not in the audit)

| What | Why it mattered |
| --- | --- |
| `apps/api` typecheck was broken on `main` (`hinglish.test.ts` used `chunkIndex`, the type is `chunkIdx`) | The audit's exit gate requires a clean typecheck; the whole API package failed `tsc --noEmit`. |
| `infra-validate` parity was red on `main` | `LICENSE_SIGNING_KID`, `R2_PUBLIC_ENDPOINT` and `S3_PUBLIC_ENDPOINT` were in CONTRACTS §1 and in the env schema but provisioned nowhere. Added to Terraform and the chart; `LLM_BASE_URL`/`LLM_MODEL` recorded in CONTRACTS §1, which was behind the code. Parity is now an exact match. |
| Render style-catalogue test asserted a hard-coded count of 30 against 66 actual styles | A magic number turns "we shipped a template" into a failing render suite. Now asserts every style parses. |
| `apps/web` vitest never ran anything under `content/` | Tests written beside the nav and legal copy would have been silently skipped. |

---

## 4. Deliberately **not** done

Stating these plainly, because a list of changes without its exclusions reads as
completeness.

**Per-service environment validation (the residual half of P0-09).**
`externalSecrets.shared` still gives `worker-media` and `render` the
`DATABASE_URL` and both JWT keys, which neither uses. That is forced by
`loadEnv()` having one required set for every service, not by the chart. The fix
is to derive per-service schemas with `envSchema.pick()` and have
`apps/worker-media/src/settings.ts` and `apps/render/src/config.ts` validate only
their own subset. Until that lands, **do not describe the workers as least
privilege.**

**Real per-role process entry points.** The chart no longer claims an isolation
that does not exist, and the binary refuses to pretend — but `realtime` and
`scheduler` are still not separate processes. The audit's own launch guidance is
"deploy one coherent API service and do not pretend the roles are isolated",
which is what this now does. Splitting the module graph is a P1 refactor.

**The application delivery pipeline (most of P0-02).** The stale job is gone and
the audit is now a real gate, but there is still **no workflow that builds,
scans, signs and pushes the five runtime images**. That is the largest single
gap left in this repository, and it was left deliberately: a publish pipeline
needs a registry to publish to, an OIDC role to publish with, and an environment
to deploy into, none of which exist. Writing one against placeholder values would
produce exactly what the audit criticises everywhere else — infrastructure that
reads as done and has never run. Build it in the same change that creates the
registry.

**Running the load harness (most of P0-05).** The harness can now distinguish a
fixed per-request cost from queueing, and reports its own blind spots — but the
3.67 s p95 is not diagnosed, because diagnosing it needs the stack running and,
per the audit, the real run belongs on staging at the release digest. One
observation worth carrying into that run: the 2026-09-02 report's p50 of
3598.5 ms against a p95 of 3672.8 ms is a 2% spread, which is not a latency tail.
Every request cost the same, which is the signature of a queue draining rather
than a slow handler. `LOAD_CONCURRENCY=1` against the same build is the cheapest
way to confirm that before anyone optimises the handler.

**Any dependency bump beyond the four overrides.** The launch plan says fix only
release blockers and repeat the affected tests. A lockfile-wide upgrade cannot be
verified from here.

**Everything requiring an account, a contract or counsel.** No AWS, Cloudflare,
Google Cloud, SES, Razorpay or paging account was available, so nothing was
provisioned, applied, verified or drilled. The Terraform and chart changes are
**unapplied code**. Legal copy is still marked draft because only counsel can
change that.

---

## 5. Still blocking, and only a human can clear it

Ordered by what stops the launch soonest.

1. **Name an owner for the `deepmerge-ts` audit exception** (or fix it). CI is
   red until someone does. `security/audit-exceptions.json`.
2. **Confirm the brand decision.** This work restored Aksharo on the evidence:
   CONTRACTS §0 decision D59, the live hostnames, the `aksharo_rt` cookie and
   the `ai.aksharo.*` plugin ids all say Aksharo, and `kalakar.io` is a domain
   this project does not own. If that is wrong, it is wrong in one file — but
   shipping a competitor's trademark as the product's own name is not a
   decision to leave to a default.
3. **Decide the deployment target.** Every infrastructure change here is
   unapplied Terraform and Helm. Nothing is deployed; the public site is still
   this laptop through a Cloudflare Tunnel.
4. **Everything in the audit's own go/no-go board.** SES production access,
   the Google consent screen, counsel's approval, the capacity run, the restore
   drill, paging. No code change moves those.

---

## 6. Verification actually run

Source-only. The production processes on ports 3913 and 3914 were **not**
rebuilt or restarted, so the live site is unchanged by this work.

| Gate | Result |
| --- | --- |
| `apps/api` unit tests | 2049 passed / 198 files |
| `apps/web` unit tests | 1321 passed / 177 files |
| `apps/render` | 293 passed / 27 files (was 285 passed with 8 failing) |
| `packages/render-core` | 820 passed |
| `packages/edg` | 315 passed |
| `packages/ui` | 95 passed |
| `packages/caption-styles` | 79 passed |
| `packages/config` | 86 passed |
| `apps/worker-media` | 168 passed |
| typecheck (api, web, worker-media, render, config, caption-styles) | clean |
| `pnpm --filter @montaj/web build` | exit 0 |
| `pnpm --filter @montaj/web lint` | 20 errors before, 20 after — none added (the baseline had already drifted from the 13 recorded in `CLAUDE.md`) |
| `infra/scripts/validate-chart-local.mjs` | all checks pass |
| `infra/scripts/check-contracts-parity.py` | exact match (was failing) |
| `pnpm audit --prod --audit-level=high` | exit 0, 1 ignored with a registered exception |

**Not run:** the e2e suite (it points at the production API), Helm and Terraform
validation (neither binary is installed here), and the load harness (needs a
running stack, and per the audit must run against staging at the release digest).
