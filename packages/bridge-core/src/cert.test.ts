import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestCertificate, fingerprintOf, loadOrCreateCertificate } from "./cert.js";
import { InMemoryKeyStore } from "./keystore.js";

describe("createTestCertificate", () => {
  it("produces a PEM cert/key pair with a stable fingerprint", () => {
    const cert = createTestCertificate();
    expect(cert.certPem).toContain("BEGIN CERTIFICATE");
    expect(cert.privateKeyPem).toContain("PRIVATE KEY");
    expect(cert.fingerprint).toHaveLength(64); // sha256 hex
    expect(fingerprintOf(cert.certPem)).toBe(cert.fingerprint);
  });

  it("generates a distinct cert each call (per-install, never shared/committed)", () => {
    const a = createTestCertificate();
    const b = createTestCertificate();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("loadOrCreateCertificate", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("generates and caches a cert, storing the private key in the given KeyStore", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cert-"));
    const keyStore = new InMemoryKeyStore();

    const first = await loadOrCreateCertificate(keyStore, dir);
    expect(first.certPem).toContain("BEGIN CERTIFICATE");
    expect(await keyStore.load("bridge-leaf-private-key")).toBe(first.privateKeyPem);
    // The private key never touches disk once a KeyStore is in play.
    expect(existsSync(join(dir, "leaf.key.pem"))).toBe(false);

    const second = await loadOrCreateCertificate(keyStore, dir);
    expect(second).toEqual(first);
  });

  it("migrates a legacy on-disk private key into the KeyStore on first run", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cert-migrate-"));
    const legacy = createTestCertificate();
    writeFileSync(join(dir, "leaf.pem"), legacy.certPem, { mode: 0o600 });
    writeFileSync(join(dir, "leaf.key.pem"), legacy.privateKeyPem, { mode: 0o600 });
    const keyStore = new InMemoryKeyStore();

    const loaded = await loadOrCreateCertificate(keyStore, dir);
    expect(loaded.certPem).toBe(legacy.certPem);
    expect(loaded.privateKeyPem).toBe(legacy.privateKeyPem);
    expect(await keyStore.load("bridge-leaf-private-key")).toBe(legacy.privateKeyPem);
    // The legacy plaintext file is removed once migrated.
    expect(existsSync(join(dir, "leaf.key.pem"))).toBe(false);
  });

  it("regenerates the cert if it exists on disk but the key is reachable nowhere", async () => {
    dir = mkdtempSync(join(tmpdir(), "bridge-cert-orphan-"));
    const orphan = createTestCertificate();
    writeFileSync(join(dir, "leaf.pem"), orphan.certPem, { mode: 0o600 });
    const keyStore = new InMemoryKeyStore();

    const loaded = await loadOrCreateCertificate(keyStore, dir);
    expect(loaded.certPem).not.toBe(orphan.certPem);
    expect(readFileSync(join(dir, "leaf.pem"), "utf8")).toBe(loaded.certPem);
  });
});
