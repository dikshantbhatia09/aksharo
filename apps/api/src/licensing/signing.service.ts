import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { ENV } from "../config/config.module.js";

import type { KeyObject } from "node:crypto";

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * Signs and verifies the licence-key offline payload and the daily revocation
 * snapshot (05 §8: "signed ... offline window 7 days"; brief §3: "a signed
 * daily snapshot for offline clients"), as a compact three-part token —
 * `base64url(header).base64url(payload).base64url(signature)` — exactly the
 * shape `auth/token.service.ts` uses for access tokens, and for the same
 * reason: one algorithm, hand-verified against a literal before the signature
 * check runs, is easier to audit than pulling in a general JWS library for a
 * token nothing outside this codebase ever has to parse.
 *
 * Deliberately reuses `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (CONTRACTS §1) rather
 * than adding a third RSA key pair to `.env.example` — a licence payload and an
 * access token are both "the API attests to a fact, offline-verifiable by
 * anyone holding the public key", and this repository already treats that key
 * pair as rotatable. `LICENSE_SIGNING_KID` (default `"k1"`) is embedded in
 * every payload precisely so a future key rotation can be told apart by a
 * client caching an old snapshot, without minting a second secret today.
 * Flagged as a deviation for the orchestrator: the brief names `kid` as part
 * of the payload shape but does not say the key pair must be distinct from the
 * access-token one, and no second key pair exists anywhere in this codebase's
 * env schema to draw from.
 */
@Injectable()
export class SigningService {
  private privateKey?: KeyObject;
  private publicKey?: KeyObject;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get kid(): string {
    return this.env.LICENSE_SIGNING_KID;
  }

  sign(payload: Record<string, unknown>): string {
    const signingInput = `${base64url({ alg: "RS256", typ: "AKLIC", kid: this.kid })}.${base64url(payload)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput, "utf8")
      .sign(this.signingKey())
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }

  /**
   * Verify signature and algorithm only -- never expiry, which callers
   * (offline clients included) judge against their own clock and their own
   * skew tolerance, not this service's.
   */
  verify<T = Record<string, unknown>>(
    token: string,
  ): { header: { kid: string }; payload: T } | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (
      typeof header !== "object" ||
      header === null ||
      (header as { alg?: unknown }).alg !== "RS256"
    ) {
      return null;
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const ok = createVerify("RSA-SHA256")
      .update(signingInput, "utf8")
      .verify(this.verifyingKey(), Buffer.from(encodedSignature, "base64url"));
    if (!ok) return null;

    return { header: header as { kid: string }, payload: payload as T };
  }

  private signingKey(): KeyObject {
    this.privateKey ??= createPrivateKey(this.env.JWT_PRIVATE_KEY);
    return this.privateKey;
  }

  private verifyingKey(): KeyObject {
    this.publicKey ??= createPublicKey(this.env.JWT_PUBLIC_KEY);
    return this.publicKey;
  }
}
