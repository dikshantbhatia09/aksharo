import { describe, expect, it } from "vitest";

import { USER_CODE_ALPHABET, USER_CODE_LENGTH } from "./auth.constants.js";
import {
  codeChallengeS256,
  formatUserCode,
  generateCodeVerifier,
  generateUserCode,
  hashesEqual,
  normaliseUserCode,
  randomToken,
  sha256Hex,
} from "./tokens.js";

describe("randomToken", () => {
  it("is base64url of the requested byte length and never repeats", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const many = new Set(Array.from({ length: 200 }, () => randomToken(32)));
    expect(many.size).toBe(200);
  });
});

describe("sha256Hex / hashesEqual", () => {
  it("hashes to 64 hex characters and compares equal digests", () => {
    const digest = sha256Hex("hello");
    expect(digest).toHaveLength(64);
    expect(hashesEqual(digest, sha256Hex("hello"))).toBe(true);
    expect(hashesEqual(digest, sha256Hex("hell0"))).toBe(false);
    expect(hashesEqual(digest, "short")).toBe(false);
  });
});

describe("user codes (CONTRACTS §5)", () => {
  it("is 8 characters drawn only from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateUserCode();
      expect(code).toHaveLength(USER_CODE_LENGTH);
      for (const character of code) expect(USER_CODE_ALPHABET).toContain(character);
    }
  });

  it("excludes every confusable glyph", () => {
    // No 0/O, no 1/I, no U/V confusion, and no vowels: a random code can then
    // never spell a word the user has to read out loud.
    for (const glyph of ["0", "O", "1", "I", "A", "E", "U", "Y"]) {
      expect(USER_CODE_ALPHABET).not.toContain(glyph);
    }
  });

  it("formats and normalises round-trip, and rejects rubbish", () => {
    const code = generateUserCode();
    expect(formatUserCode(code)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(normaliseUserCode(formatUserCode(code).toLowerCase())).toBe(code);
    expect(normaliseUserCode(`  ${formatUserCode(code)}  `)).toBe(code);
    expect(normaliseUserCode("SHORT")).toBeUndefined();
    expect(normaliseUserCode("00000000")).toBeUndefined();
  });
});

describe("PKCE", () => {
  it("produces a 43-character verifier and a matching S256 challenge", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(codeChallengeS256(verifier)).toHaveLength(43);
    expect(codeChallengeS256(verifier)).toBe(codeChallengeS256(verifier));
    expect(codeChallengeS256(verifier)).not.toBe(codeChallengeS256(generateCodeVerifier()));
  });

  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
