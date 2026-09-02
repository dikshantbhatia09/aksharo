/**
 * Release-pipeline environment variables. NOT part of `docs/CONTRACTS.md` §1 yet — this
 * package adds new secret names (signing/notarisation/publish) that CONTRACTS does not
 * list. Report to the orchestrator: CONTRACTS §1 needs a C00 addition; do not edit it here.
 *
 * `RELEASE_MODE` gates everything: `dry-run` (default) never touches a real signer,
 * notarisation service or object store. `signed` requires every secret the selected
 * provider needs, checked eagerly and fails closed (`ReleaseFailClosedError`) instead of
 * silently falling back to dry-run.
 */
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
export const ZXP_SIGN_SECRETS = ["ZXP_CERT_P12_BASE64", "ZXP_CERT_PASSWORD", "ZXP_TIMESTAMP_URL"] as const;

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
  const missing = secretNames.filter((name) => !env[name] || env[name]?.trim() === "");
  if (missing.length > 0) {
    throw new ReleaseFailClosedError(
      `RELEASE_MODE=signed but ${missing.length} required secret(s) are not set: ${missing.join(", ")}. ` +
        `Set them (see .env.example) or run with --dry-run / RELEASE_MODE=dry-run.`,
      missing,
    );
  }
}
