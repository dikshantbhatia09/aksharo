import { createHmac, randomInt } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { SHARE_TOKEN_ALPHABET, SHARE_TOKEN_LENGTH } from "./share.constants.js";
import { ENV } from "../config/config.module.js";

/**
 * Share-link tokens (F-501): base62, {@link SHARE_TOKEN_LENGTH} characters,
 * generated with `randomInt` (rejection-sampled by Node, so the distribution is
 * uniform — the same reasoning `generateUserCode` in `auth/tokens.ts` gives).
 *
 * The token is stored and looked up in plaintext (it is itself the bearer
 * secret) — `share_links.token` is `@unique`, and THREAT-MODEL T21's mitigation
 * is entropy plus rate limiting, not a second secret.
 */
export function generateShareToken(): string {
  let token = "";
  for (let index = 0; index < SHARE_TOKEN_LENGTH; index += 1) {
    token += SHARE_TOKEN_ALPHABET[randomInt(SHARE_TOKEN_ALPHABET.length)];
  }
  return token;
}

/**
 * Signs and verifies the share-session cookie set once a password-gated link
 * has been unlocked, so the viewer is not asked again on every request.
 *
 * HMAC over the token plus an expiry, keyed on the same internal secret already
 * used for worker callbacks (`INTERNAL_CALLBACK_SECRET`) — no new secret to
 * provision (07 §Conventions: reuse before inventing).
 */
@Injectable()
export class ShareSessionSigner {
  constructor(@Inject(ENV) private readonly env: Env) {}

  sign(token: string, expiresAtMs: number): string {
    const payload = `${token}.${String(expiresAtMs)}`;
    const mac = createHmac("sha256", this.env.INTERNAL_CALLBACK_SECRET)
      .update(payload)
      .digest("hex");
    return `${payload}.${mac}`;
  }

  /** `false` when the cookie is missing, malformed, expired, or for the wrong token. */
  verify(cookieValue: string | undefined, token: string): boolean {
    if (cookieValue === undefined || cookieValue === "") return false;
    const parts = cookieValue.split(".");
    if (parts.length !== 3) return false;
    const [cookieToken, expiresAtRaw, mac] = parts;
    // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
    if (cookieToken !== token) return false;
    const expiresAtMs = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
    const expected = createHmac("sha256", this.env.INTERNAL_CALLBACK_SECRET)
      .update(`${cookieToken}.${expiresAtRaw}`)
      .digest("hex");
    return expected === mac;
  }
}
