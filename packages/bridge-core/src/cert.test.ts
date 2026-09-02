import { describe, expect, it } from "vitest";

import { createTestCertificate, fingerprintOf } from "./cert.js";

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
