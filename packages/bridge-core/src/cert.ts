import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import selfsigned from "selfsigned";

import { aksharoDir } from "./discovery.js";

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

function certPath(): string {
  return join(certDir(), "leaf.pem");
}

function keyPath(): string {
  return join(certDir(), "leaf.key.pem");
}

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

/** Loads the cached per-install cert, generating and caching one on first run. */
export function loadOrCreateCertificate(): BridgeCertificate {
  const dir = certDir();
  if (existsSync(certPath()) && existsSync(keyPath())) {
    const certPem = readFileSync(certPath(), "utf8");
    const privateKeyPem = readFileSync(keyPath(), "utf8");
    return { certPem, privateKeyPem, fingerprint: fingerprintOf(certPem) };
  }

  const cert = generate();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(certPath(), cert.certPem, { mode: 0o600 });
  writeFileSync(keyPath(), cert.privateKeyPem, { mode: 0o600 });
  return cert;
}

/** For tests: a fresh, clearly-marked self-signed cert that touches no disk. */
export function createTestCertificate(): BridgeCertificate {
  return generate();
}
