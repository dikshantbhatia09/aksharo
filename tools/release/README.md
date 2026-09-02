# @montaj/release

Signing & release pipeline CLI (C00). `pnpm release <command>` from the repo root; see
`docs/RELEASE.md` for the full runbook and `docs/CONTRACTS.md` for the frozen interfaces this
package must not touch.

**Dry-run only, by design.** `RELEASE_MODE` defaults to `dry-run` and every command's own
`--dry-run` flag also defaults to `true`; nothing in this package ever signs a real binary,
calls Apple's notarytool, or uploads to R2 unless `RELEASE_MODE=signed` **and** every secret
the selected provider needs is set (checked eagerly by `requireSecretsIfSigned` in
`src/env.ts`) — otherwise it fails closed with `ReleaseFailClosedError`.

## Layout

- `src/cli.ts` — commander entry point (`pnpm release ...`)
- `src/commands/*` — one module per subcommand, each with a plain async `run*` function the
  CLI action wraps (kept separate so commands are unit-testable without spawning the CLI)
- `src/signing/*` — the `SignProvider` seam: `DryRunSignProvider` (default),
  `AzureTrustedSigningProvider`, `DigiCertKeyLockerProvider`, `MacDeveloperIdProvider`
- `src/lib/*` — nested-binary discovery, the 24h notarisation-buffer ledger, checksum
  manifest, UXP manifest validation, a dependency-free zip writer, SBOM/feed helpers
- `tests/*` — vitest; fixture-tree tests for nested binary discovery, a fake-clock test suite
  for the 24h rule, manifest validation, checksum round-trips, and an end-to-end dry-run walk
  of build -> checksums -> notarize -> publish -> promote

## Known gap

`AzureTrustedSigningProvider` is the brief's stated default, but Azure Trusted Signing does
not issue public-trust certificates to an Indian entity (RR-07 §P0; the operating entity is
fixed as Indian by D69). `WIN_SIGN_PROVIDER=digicert-key-locker` is the practical default —
see `docs/RELEASE.md` §0.
