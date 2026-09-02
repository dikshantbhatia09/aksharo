import { describe, expect, it } from "vitest";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./auth.constants.js";
import { PasswordService } from "./password.service.js";

const passwords = new PasswordService();

describe("PasswordService.hash / verify", () => {
  it("produces an argon2id PHC string with the parameters the brief fixed", async () => {
    const hash = await passwords.hash("a-long-enough-password");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(passwords.needsRehash(hash)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const [first, second] = await Promise.all([
      passwords.hash("a-long-enough-password"),
      passwords.hash("a-long-enough-password"),
    ]);
    expect(first).not.toBe(second);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await passwords.hash("a-long-enough-password");
    await expect(passwords.verify(hash, "a-long-enough-password")).resolves.toBe(true);
    await expect(passwords.verify(hash, "a-long-enough-passwore")).resolves.toBe(false);
  });

  it("still does the work when there is no stored hash", async () => {
    // The point is that "no such account" costs the same as "wrong password".
    await expect(passwords.verify(null, "anything-at-all")).resolves.toBe(false);
  });

  it("denies rather than throws on a corrupt stored hash", async () => {
    await expect(passwords.verify("not-a-phc-string", "anything-at-all")).resolves.toBe(false);
  });

  it("asks for a rehash when the stored parameters are weaker than the policy", async () => {
    // 19 MiB / 2 passes: the library's own defaults, and below ours.
    expect(passwords.needsRehash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g")).toBe(
      true,
    );
    expect(passwords.needsRehash("nonsense")).toBe(true);
  });
});

describe("PasswordService.check", () => {
  it("accepts an ordinary long password", () => {
    expect(passwords.check("a-long-enough-password", "someone@example.test")).toBeUndefined();
  });

  it("rejects one below the length floor", () => {
    expect(passwords.check("x".repeat(PASSWORD_MIN_LENGTH - 1), "a@b.test")).toBe("too_short");
  });

  it("rejects an absurdly long one", () => {
    expect(passwords.check("x".repeat(PASSWORD_MAX_LENGTH + 1), "a@b.test")).toBe("too_long");
  });

  it("rejects one built from the address", () => {
    expect(passwords.check("Bilberry-Bilberry", "bilberry@example.test")).toBe("contains_email");
    // A two-character local part is too short to be a meaningful signal.
    expect(passwords.check("jo-is-a-fine-name", "jo@example.test")).toBeUndefined();
  });

  it("raises auth/weak_password with the limits in the details", () => {
    expect(() => {
      passwords.assertAcceptable("short", "a@b.test");
    }).toThrowError(expect.objectContaining({ code: "auth/weak_password" }));

    try {
      passwords.assertAcceptable("x".repeat(PASSWORD_MAX_LENGTH + 1), "a@b.test");
    } catch (error) {
      expect((error as { details: { reason: string } }).details.reason).toBe("too_long");
    }

    expect(() => {
      passwords.assertAcceptable("a-long-enough-password", "a@b.test");
    }).not.toThrow();
  });
});
