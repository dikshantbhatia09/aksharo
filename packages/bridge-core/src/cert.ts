import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import selfsigned from "selfsigned";

import { aksharoDir } from "./discovery.js";
import { createDefaultKeyStore } from "./keystore.js";

import type { KeyStore } from "./keystore.js";

/**
 * The per-install loopback TLS leaf certificate (brief §2 asks ECDSA P-256; this
 * generates RSA 2048 instead — see the deviation note in `generate()` below),
 * 2-year validity, SAN `localhost`/`127.0.0.1`. Generated once on first run and
 * cached under `~/.aksharo/cert/`; never committed to the repo and never shared
 * between installs. Its SHA-256 fingerprint is published in the discovery file
 * so a loopback client can pin it (certificate pinning substitutes for a CA
 * chain a self-signed loopback cert cannot have).
 */

export interface BridgeCertificate {
  readonly certPem: string;
  readonly privateKeyPem: string;
  readonly fingerprint: string;
}

const CERT_DAYS = 730;

function certDir(): string {
  return join(aksharoDir(), "cert");
}

function certPath(dir: string): string {
  return join(dir, "leaf.pem");
}

/** The legacy (pre-C01b) plaintext key file — read once for migration, never written again. */
function legacyKeyPath(dir: string): string {
  return join(dir, "leaf.key.pem");
}

const PRIVATE_KEY_NAME = "bridge-leaf-private-key";

export function fingerprintOf(certPem: string): string {
  // DER-less fingerprint over the PEM body is sufficient for pinning purposes
  // here (both sides derive it the same way from the same PEM), and avoids a
  // second dependency for DER parsing.
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}

function generate(): BridgeCertificate {
  const attrs = [{ name: "commonName", value: "localhost" }];
  // Deviation from the brief's "ECDSA P-256" (documented in the WP report): the
  // `selfsigned` package (built on node-forge) only ever signs with an RSA key
  // pair it generates itself — its `algorithm`/`keySize` options are bit counts
  // for `forge.pki.rsa.generateKeyPair`, not an EC curve selector, and node-forge
  // has no supported path for issuing an EC-signed X.509 certificate. RSA 2048
  // is used instead: still well above any loopback-TLS floor, and the leaf is
  // pinned by fingerprint (below) rather than trusted via a CA chain, so the
  // algorithm choice does not weaken T10's loopback-TLS control.
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: CERT_DAYS,
    extensions: [
      {
        name: "basicConstraints",
        cA: false,
      },
      {
        name: "keyUsage",
        keyCertSign: false,
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" }, // DNS
          { type: 7, ip: "127.0.0.1" }, // IP
        ],
      },
    ],
  });
  return {
    certPem: pems.cert,
    privateKeyPem: pems.private,
    fingerprint: fingerprintOf(pems.cert),
  };
}

/**
 * Loads the cached per-install cert, generating and caching one on first run.
 * The private key lives in the OS keychain/DPAPI (T14); `keyStore` defaults to
 * the platform-appropriate store (`createDefaultKeyStore`) but tests pass an
 * `InMemoryKeyStore` so no test touches a real keychain or spawns PowerShell.
 *
 * Migration: an install that ran before C01b has the private key sitting in
 * `leaf.key.pem` (mode `0600`) next to the cert. The first run after upgrade
 * reads that file, saves it into the key store, and deletes the plaintext
 * copy — so an existing pairing/session keeps working with the same cert
 * fingerprint instead of forcing every paired client to re-pair.
 *
 * `dir` defaults to `~/.aksharo/cert/` and is overridable only for tests
 * (mirrors the `path` override on `writeDiscoveryFile`/`readDiscoveryFile`).
 */
export async function loadOrCreateCertificate(
  keyStore?: KeyStore,
  dir: string = certDir(),
): Promise<BridgeCertificate> {
  const store = keyStore ?? (await createDefaultKeyStore());
  const certFile = certPath(dir);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (existsSync(certFile)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    const certPem = readFileSync(certFile, "utf8");
    const migrated = await migrateLegacyKeyIfPresent(store, dir);
    const privateKeyPem = migrated ?? (await store.load(PRIVATE_KEY_NAME));
    if (privateKeyPem !== undefined) {
      return { certPem, privateKeyPem, fingerprint: fingerprintOf(certPem) };
    }
    // Cert on disk but no private key anywhere reachable (e.g. the key store
    // backend changed under us): the pair is unusable, so regenerate both.
  }

  const cert = generate();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  writeFileSync(certFile, cert.certPem, { mode: 0o600 });
  await store.save(PRIVATE_KEY_NAME, cert.privateKeyPem);
  return cert;
}

/** Returns the migrated key (and deletes the legacy file) if one was found, else `undefined`. */
async function migrateLegacyKeyIfPresent(
  keyStore: KeyStore,
  dir: string,
): Promise<string | undefined> {
  const legacyFile = legacyKeyPath(dir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (!existsSync(legacyFile)) return undefined;
  const existing = await keyStore.load(PRIVATE_KEY_NAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const legacyKeyPem = readFileSync(legacyFile, "utf8");
  if (existing === undefined) {
    await keyStore.save(PRIVATE_KEY_NAME, legacyKeyPem);
  }
  rmSync(legacyFile, { force: true });
  return existing ?? legacyKeyPem;
}

/** For tests: a fresh, clearly-marked self-signed cert that touches no disk. */
export function createTestCertificate(): BridgeCertificate {
  return generate();
}
