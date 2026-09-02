import { describe, expect, it } from "vitest";

import {
  currentTotpCode,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
} from "./totp.js";

describe("totp", () => {
  it("generates a base32 secret with no padding", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("builds an otpauth:// provisioning URI", () => {
    const uri = totpProvisioningUri({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "admin@example.com",
      issuer: "Montaj Admin",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Montaj");
  });

  it("verifies the current code and rejects a wrong one", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = currentTotpCode(secret, now);
    expect(verifyTotpCode(secret, code, now)).toBe(true);
    expect(verifyTotpCode(secret, "abcdef", now)).toBe(false);
    expect(verifyTotpCode(secret, "12345", now)).toBe(false);
  });

  it("tolerates one step of clock drift either way but not two", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const oneStepAgo = currentTotpCode(secret, now - 30_000);
    const twoStepsAgo = currentTotpCode(secret, now - 60_000);
    expect(verifyTotpCode(secret, oneStepAgo, now)).toBe(true);
    expect(verifyTotpCode(secret, twoStepsAgo, now)).toBe(false);
  });

  it("rejects a code from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForB = currentTotpCode(secretB);
    expect(verifyTotpCode(secretA, codeForB)).toBe(false);
  });
});
