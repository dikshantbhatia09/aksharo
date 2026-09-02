# RELEASE.md — cutting an Aksharo release (C00)

Owner: C00. Everything in this document runs in **dry-run mode by default**. No signing
credential exists yet (A00-03 is not landed) — do not attempt to flip `RELEASE_MODE=signed`
outside a properly gated CI environment with real secrets.

**Where the secrets live (ruling 2026-09-03):** every variable below is a CI /
GitHub-environment secret, not application runtime configuration — it is consumed only by
`tools/release`'s CLI, normally injected by GitHub Actions into the `release-mac` /
`release-win` / `release-publish` environments referenced in the workflows. These do
**not** live in the root `.env.example` or `docs/CONTRACTS.md` §1 (that parity test in
`packages/config` asserts exactly one Zod schema key per contract variable and has no slot
for CI-only secrets); they live in `tools/release/.env.example`, and the release CLI loads
`tools/release/.env` itself (see `src/env.ts::loadReleaseDotEnv`, called from `src/cli.ts`)
in addition to `process.env`, so a local copy is enough to exercise signed mode by hand.

## 0. Known gap — read this before touching Windows signing

`RR-07-desktop-local-engine.md` §P0 (and `12-redesign-decisions.md` D69): **Azure Trusted
Signing does not issue public-trust certificates to an Indian entity**, and the Aksharo
operating entity is an Indian private limited company. `AzureTrustedSigningProvider` ships
in this pipeline anyway (per the C00 brief default), but as of writing it cannot actually be
provisioned. `WIN_SIGN_PROVIDER=digicert-key-locker` (`DigiCertKeyLockerProvider`) is the
practical path until the entity structure changes or Microsoft opens the programme to India.
This is reported, not silently fixed — raise it with the orchestrator before wiring real
Windows secrets.

## 1. The CLI

```
pnpm release <command> [options]
```

| Command           | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `version`         | Conventional-commit semver bump + `CHANGELOG.md` section                   |
| `build-desktop`   | electron-builder-shaped build for one `--platform` (mac/win) / `--channel` |
| `sign-nested`     | Sign + verify every nested binary in a built app tree                      |
| `notarize`        | notarytool submit/wait/staple; records the 24h ledger                      |
| `package-ccx`     | Premiere UXP plugin -> `.ccx` (no signing)                                 |
| `sign-zxp`        | AE CEP panel -> signed `.zxp`                                              |
| `package-resolve` | DaVinci Resolve script bundle + installers                                 |
| `sbom`            | CycloneDX SBOM for an artifact                                             |
| `checksums`       | `CHECKSUMS.sha256` + HMAC `SIGNATURES.txt`                                 |
| `publish`         | Upload artifacts + updater feeds to a channel                              |
| `promote`         | Copy one channel's artifacts to another (24h gate on `stable`)             |
| `verify-release`  | Re-hash a published channel dir against its manifest                       |

Every command defaults to dry-run. `RELEASE_MODE=signed` plus `--no-dry-run` (where the
command exposes that flag) is required to attempt a real signing/notarisation/publish call,
and every such call is gated by `requireSecretsIfSigned` — missing any secret the chosen
provider needs throws `ReleaseFailClosedError` and exits non-zero **before** anything is
attempted. This is the fail-closed contract acceptance criterion #2 requires.

## 2. Channels

`alpha` -> `beta` -> `stable`, each a distinct R2 prefix (`releases/<channel>/`) with its own
`latest.yml` / `latest-mac.yml` electron-updater feed. Promotion is manual
(`promote.yml`/`pnpm release promote`), never automatic.

## 3. The 24-hour notarisation buffer

`RR-07` §P0-2 / D48: notarytool has been observed stuck "In Progress" for 24–72+ hours; the
runbook assumes a 24h worst case and never launches inside that window. `notarize` records
`{ artifact, submissionId, notarizedAt, stapled }` to `.release/notarization-ledger.json`.
`publish --channel stable` and `promote --to stable` both call `evaluateStableGate`, which
blocks unless `now >= notarizedAt + 24h` **and** the ticket was stapled. An operator can
override with `--force --reason "..."` (the reason is required and is the audit trail — it
shows up in the CI run log and in `docs/RELEASE.md`'s "emergency" section below).

## 4. Cutting a release (once signing credentials exist)

1. `pnpm release version --current <version> --subjects <(git log --format=%s vX.Y.Z..HEAD) --no-dry-run` — bumps `CHANGELOG.md`.
2. Tag `release/vX.Y.Z` and push. `release-desktop.yml` and `release-plugins.yml` run the
   signed jobs behind the `release-mac`/`release-win` GitHub environments (required
   reviewers approve the run).
3. macOS artifact is notarized automatically in that job; the 24h buffer starts there.
4. Manually run `promote.yml` to move `alpha` -> `beta` once smoke-tested.
5. **Wait at least 24h from the notarization timestamp**, then run `promote.yml` for
   `beta` -> `stable`. The workflow calls `verify-release` after promoting.

## 5. Rollback

Channel feeds (`latest.yml`/`latest-mac.yml`) are the only thing electron-updater reads.
To roll back: run `promote.yml` with `--from <last-good-channel-artifact>` re-published to
`stable` (the previous version's artifact + feed files are still in R2 under their original
channel prefix — nothing is deleted on promote, only copied), or manually re-upload the
previous version's `latest*.yml` to `releases/stable/`. `verify-release` after any manual R2
edit.

## 6. Emergency revoke

If a shipped build must be pulled (e.g. a broken auto-update or a compromised signing key):

1. Remove the affected version's feed entry from `releases/<channel>/latest*.yml` (point it
   back at the last-known-good version — see Rollback).
2. If a signing key is suspected compromised, revoke it with the CA/Apple immediately (this
   is a human action outside this CLI) and open a new C00 work item to rotate
   `AZURE_TRUSTED_SIGNING_*` / `DIGICERT_KEYLOCKER_*` / `APPLE_*` secrets in the GitHub
   environments.
3. Record the incident; `SIGNATURES.txt` + the notarization ledger are the forensic trail for
   which artifact was affected and when it was notarized/published.

## 7. Checklist for the first real signed release (once A00-03 lands)

- [ ] Apple Developer **organisation** account + Developer ID Application certificate issued.
- [ ] Windows OV certificate on a cloud HSM provisioned (DigiCert KeyLocker, given the Azure
      Trusted Signing India gap in §0 — confirm this hasn't changed before assuming it).
- [ ] `APPLE_TEAM_ID`, `APPLE_DEVELOPER_ID_APPLICATION_CERT_P12_BASE64`,
      `APPLE_DEVELOPER_ID_APPLICATION_CERT_PASSWORD`, `APPLE_NOTARYTOOL_KEY_ID`,
      `APPLE_NOTARYTOOL_ISSUER_ID`, `APPLE_NOTARYTOOL_PRIVATE_KEY_BASE64` set in the
      `release-mac` GitHub environment.
- [ ] `DIGICERT_KEYLOCKER_*` (or `AZURE_*` if the India gap is resolved) set in `release-win`.
- [ ] `ZXP_CERT_P12_BASE64`, `ZXP_CERT_PASSWORD`, `ZXP_TIMESTAMP_URL` set for the AE panel.
- [ ] `RELEASE_R2_*` set for publish.
- [ ] `RELEASE_CHECKSUM_SIGNING_KEY_BASE64` generated and stored.
- [ ] A dry run of the entire pipeline (this doc, §4, with `RELEASE_MODE=dry-run`) has been
      exercised against a real `apps/desktop` build (not the placeholder tree) at least once.
- [ ] Every secret above is set in the correct GitHub environment (`release-mac`,
      `release-win`, `release-publish`) — these are CI secrets, not CONTRACTS §1 config
      (ruling 2026-09-03); nothing here needs a CONTRACTS.md change.
- [ ] Gate C (installs on real Windows and macOS machines by a human — `12-redesign-decisions.md` D50) signed off.
