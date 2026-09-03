/**
 * Release-pipeline environment variables.
 *
 * These are CI / GitHub-environment secrets (signing, notarisation, publish), not
 * application runtime configuration, so they deliberately live in `tools/release/.env.example`
 * (loaded by `loadReleaseDotEnv` below) rather than the root `.env.example` / CONTRACTS §1
 * (ruling 2026-09-03): `packages/config`'s parity test asserts exactly one schema key per
 * CONTRACTS §1 variable, and these are not app config a running service reads.
 *
 * `RELEASE_MODE` gates everything: `dry-run` (default) never touches a real signer,
 * notarisation service or object store. `signed` requires every secret the selected
 * provider needs, checked eagerly and fails closed (`ReleaseFailClosedError`) instead of
 * silently falling back to dry-run.
 */
import { readFileSync } from "node:fs";

import { ReleaseFailClosedError } from "./types.js";

export type WinSignProviderName = "azure-trusted-signing" | "digicert-key-locker";

export function releaseMode(env: NodeJS.ProcessEnv = process.env): "dry-run" | "signed" {
  const raw = env.RELEASE_MODE?.trim().toLowerCase();
  return raw === "signed" ? "signed" : "dry-run";
}

export function winSignProviderName(env: NodeJS.ProcessEnv = process.env): WinSignProviderName {
  const raw = env.WIN_SIGN_PROVIDER?.trim();
  return raw === "digicert-key-locker" ? "digicert-key-locker" : "azure-trusted-signing";
}

/** Secrets required for Apple notarisation (macOS). */
export const APPLE_NOTARIZE_SECRETS = [
  "APPLE_TEAM_ID",
  "APPLE_DEVELOPER_ID_APPLICATION_CERT_P12_BASE64",
  "APPLE_DEVELOPER_ID_APPLICATION_CERT_PASSWORD",
  "APPLE_NOTARYTOOL_KEY_ID",
  "APPLE_NOTARYTOOL_ISSUER_ID",
  "APPLE_NOTARYTOOL_PRIVATE_KEY_BASE64",
] as const;

/** Azure Trusted Signing (cloud HSM). Research flag: public-trust certs are not issued to
 * an Indian entity as of RR-07 §P0 — see docs/RELEASE.md "Known gap" before relying on this
 * as the production default. */
export const AZURE_TRUSTED_SIGNING_SECRETS = [
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_CERT_PROFILE",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
] as const;

/** DigiCert KeyLocker (cloud HSM), used when `WIN_SIGN_PROVIDER=digicert-key-locker`. */
export const DIGICERT_KEY_LOCKER_SECRETS = [
  "DIGICERT_KEYLOCKER_API_KEY",
  "DIGICERT_KEYLOCKER_CLIENT_CERT_BASE64",
  "DIGICERT_KEYLOCKER_CLIENT_CERT_PASSWORD",
  "DIGICERT_KEYLOCKER_KEYPAIR_ALIAS",
  "SM_HOST",
] as const;

/** ZXP signing (Adobe CEP, After Effects panel). Dry-run uses a generated self-signed dev cert. */
export const ZXP_SIGN_SECRETS = [
  "ZXP_CERT_P12_BASE64",
  "ZXP_CERT_PASSWORD",
  "ZXP_TIMESTAMP_URL",
] as const;

/** R2 (S3-compatible) bucket the `publish` command uploads channel artifacts to. */
export const PUBLISH_SECRETS = [
  "RELEASE_R2_ENDPOINT",
  "RELEASE_R2_BUCKET",
  "RELEASE_R2_ACCESS_KEY",
  "RELEASE_R2_SECRET_KEY",
] as const;

/** Signing key for `SIGNATURES.txt` (checksums manifest signature, not code signing). */
export const CHECKSUM_SIGNING_SECRETS = ["RELEASE_CHECKSUM_SIGNING_KEY_BASE64"] as const;

/**
 * Throws `ReleaseFailClosedError` listing every missing secret when `mode === "signed"`.
 * No-op in dry-run mode by design (dry-run never needs real secrets).
 */
export function requireSecretsIfSigned(
  mode: "dry-run" | "signed",
  secretNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (mode !== "signed") return;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const missing = secretNames.filter((name) => !env[name] || env[name]?.trim() === "");
  if (missing.length > 0) {
    throw new ReleaseFailClosedError(
      `RELEASE_MODE=signed but ${missing.length} required secret(s) are not set: ${missing.join(", ")}. ` +
        `Set them (see .env.example) or run with --dry-run / RELEASE_MODE=dry-run.`,
      missing,
    );
  }
}

// --- Loading tools/release/.env (this package's own dotenv file) -----------------------

/**
 * Parses a `.env`-style file (`KEY=value` lines, `#` comments, optional quotes) without a
 * dependency. Used only to load `tools/release/.env` — never the repo root `.env`, which
 * covers application runtime config (CONTRACTS §1), not CI/GitHub-environment release
 * secrets (2026-09-03 ruling: release secrets are CI-only and must not sit in the root
 * `.env.example` / CONTRACTS §1, since `packages/config`'s parity test asserts exactly one
 * schema key per contract variable).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    out[key] = value;
  }
  return out;
}

/**
 * Loads `tools/release/.env` (if present) into `process.env`, filling in only the keys not
 * already set — a real environment variable (a GitHub Actions secret, a shell export) always
 * wins over the local file. Safe to call multiple times; missing file is a silent no-op
 * (most contributors never need a local `.env` here since dry-run needs no secret at all).
 */
export function loadReleaseDotEnv(dotEnvPath: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    text = readFileSync(dotEnvPath, "utf8");
  } catch {
    return;
  }
  const parsed = parseDotEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (env[key] === undefined || env[key] === "") {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      env[key] = value;
    }
  }
}
