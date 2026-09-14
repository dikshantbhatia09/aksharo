import { describe, expect, it } from "vitest";

import { commonPasswordReason, normalisations, normalise } from "./common-passwords.js";

describe("normalise", () => {
  it("undoes the decorations a rule engine would have added", () => {
    expect(normalisations("P@ssw0rd!2024")).toContain("password");
    expect(normalisations("Qwerty123!")).toContain("qwerty");
    expect(normalisations("--Admin--")).toContain("admin");
    expect(normalisations("2024letmein")).toContain("letmein");
  });

  it("leaves an ordinary passphrase recognisable", () => {
    expect(normalise("correct horse battery staple")).toBe("correcthorsebatterystaple");
  });
});

describe("commonPasswordReason", () => {
  /**
   * The point of the local list: these all clear the 15-character floor, so
   * length alone would have accepted every one of them.
   */
  it("rejects a common password however it is decorated", () => {
    for (const password of [
      "password12345678",
      "P@ssw0rd!2024!!!",
      "letmein!!!!!!!!!!",
      "Qwertyuiop123456",
      "iloveyou!!!!!!!!",
      "administrator!!!",
    ]) {
      expect(commonPasswordReason(password), password).toBeDefined();
    }
  });

  it("rejects a password padded out to length with one character", () => {
    expect(commonPasswordReason("aaaaaaaaaaaaaaaa")).toBe("repeated_characters");
    expect(commonPasswordReason("................")).toBe("repeated_characters");
  });

  it("rejects a run along the alphabet or the number row", () => {
    expect(commonPasswordReason("abcdefghijklmnop")).toBe("sequential_characters");
    expect(commonPasswordReason("zyxwvutsrqponml")).toBe("sequential_characters");
  });

  it("rejects a short unit repeated up to length", () => {
    expect(commonPasswordReason("abcabcabcabcabc")).toBe("sequential_characters");
    expect(commonPasswordReason("12121212121212")).toBe("sequential_characters");
  });

  it("rejects the product's own name", () => {
    expect(commonPasswordReason("aksharo-is-great")).toBe("contains_product_name");
    expect(commonPasswordReason("Aksharo2026!!!!!")).toBe("contains_product_name");
  });

  /**
   * Nothing here may behave like a composition rule. A long, unusual passphrase
   * with no digits, no symbols and no capitals is exactly what SP 800-63B-4
   * wants people to choose.
   */
  it("accepts long, unusual passwords with no composition tricks", () => {
    for (const password of [
      "correct horse battery staple",
      "seventeen jackdaws quibble",
      "मेरा पासवर्ड बहुत लंबा है",
      "a-long-enough-password",
      "Tr0ub4dor&3xxxxxxxx",
    ]) {
      expect(commonPasswordReason(password), password).toBeUndefined();
    }
  });
});
