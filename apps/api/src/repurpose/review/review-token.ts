import { createHash } from "node:crypto";

import { generateShareToken } from "../../share/token.js";

/**
 * A client review link's token (2026-10-03).
 *
 * Minted the way share-link tokens are (`share/token.ts`: 24 base62 characters
 * from `randomInt`, over 142 bits), but never stored: the database keeps its
 * SHA-256 (`clip_review_links.token_hash`), so a copy of the table, a backup or
 * a log of a query hands out no working link. The cost is that the full link is
 * shown once, when it is made; a lost one is revoked and made again. A plain
 * hash, not a slow one, is right for a 142-bit random secret: there is nothing
 * to guess, only to look up.
 */
export function generateReviewToken(): string {
  return generateShareToken();
}

export function hashReviewToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The last four characters, shown beside a link so two can be told apart. */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/** `SHARE_TOKEN_ALPHABET` (base62) times `SHARE_TOKEN_LENGTH` (24); the test holds them together. */
const TOKEN_SHAPE = /^[0-9A-Za-z]{24}$/;

/**
 * Whether a string could be a token at all. Checked before any lookup, so a
 * malformed path costs no query and every miss looks the same.
 */
export function looksLikeReviewToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}
