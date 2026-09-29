import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateReviewToken,
  hashReviewToken,
  looksLikeReviewToken,
  tokenHint,
} from "./review-token.js";
import { SHARE_TOKEN_ALPHABET, SHARE_TOKEN_LENGTH } from "../../share/share.constants.js";

describe("review link tokens", () => {
  it("are share-link strength: 24 base62 characters, and never the same twice", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateReviewToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
      for (const char of token) expect(SHARE_TOKEN_ALPHABET).toContain(char);
      // The shape check agrees with the generator it guards.
      expect(looksLikeReviewToken(token)).toBe(true);
    }
  });

  it("are stored as a SHA-256, never as themselves", () => {
    const token = generateReviewToken();
    const hash = hashReviewToken(token);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it("show only their last four characters", () => {
    expect(tokenHint("ABCDEFGHIJKLMNOPQRSTwxyz")).toBe("wxyz");
  });

  it("refuse anything that could not be a token before any lookup", () => {
    for (const bad of [
      "",
      "short",
      "ABCDEFGHIJKLMNOPQRSTUVWXY",
      "ABCDEFGHIJKLMNOPQRSTUVW-",
      "../../../../etc/passwd000",
      "ABCDEFGHIJKLMNOPQRSTUVWé",
    ]) {
      expect(looksLikeReviewToken(bad), bad).toBe(false);
    }
  });
});
