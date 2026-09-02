import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { ulid } from "ulid";

import { BridgeRpcError, BRIDGE_ERROR_CODES } from "./protocol.js";

import type { ClientKindSchema } from "./protocol.js";
import type { z } from "zod";

/**
 * Pairing (brief §4): a client asks to pair, the bridge shows a tray gesture
 * (or, headless, an 8-character code), and on approval issues a 12-hour scoped
 * pair token bound to the client kind. `session.exchange` later trades that
 * pair token for a short-lived session token used on every subsequent call.
 */

const PAIR_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;
const SESSION_TOKEN_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous glyphs (0/O, 1/I/l)

export type ClientKind = z.infer<typeof ClientKindSchema>;

export interface PendingPairing {
  readonly pairingId: string;
  readonly clientKind: ClientKind;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly code: string;
  readonly createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
}

export interface IssuedPairToken {
  readonly clientId: string;
  readonly clientKind: ClientKind;
  readonly scopes: readonly string[];
  readonly exp: number;
}

export interface TrayGesture {
  /**
   * Show "Approve pairing for <client>?" and resolve when the user clicks the
   * tray menu item (approve) or dismisses/ignores it (never resolves; the
   * pairing simply expires). Rejects only on a hard tray failure, which the
   * pairing service treats as "fall back to the code".
   */
  requestApproval(pairing: PendingPairing): Promise<"approved" | "denied">;
}

/** A tray gesture that always fails, forcing the code fallback — used headless/CI. */
export const NO_TRAY_GESTURE: TrayGesture = {
  requestApproval() {
    return Promise.reject(new Error("no tray available"));
  },
};

function generateCode(): string {
  let out = "";
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class PairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly revokedClientIds = new Set<string>();
  private readonly secret: string;

  constructor(
    secret: string,
    private readonly tray: TrayGesture = NO_TRAY_GESTURE,
  ) {
    this.secret = secret;
  }

  /** `pair.request`: creates a pending pairing and fires the tray gesture (best effort). */
  request(clientKind: ClientKind, clientName: string, scopes: readonly string[]): PendingPairing {
    const now = Date.now();
    const pairing: PendingPairing = {
      pairingId: ulid(),
      clientKind,
      clientName,
      scopes,
      code: generateCode(),
      createdAt: now,
      expiresAt: now + PAIRING_REQUEST_TTL_MS,
      status: "pending",
    };
    this.pending.set(pairing.pairingId, pairing);

    // Fire-and-forget: a tray click resolves this asynchronously; a headless
    // bridge (or a tray error) leaves the pairing awaiting the code instead.
    this.tray.requestApproval(pairing).then(
      (decision) => {
        const current = this.pending.get(pairing.pairingId);
        if (current === undefined || current.status !== "pending") return;
        current.status = decision;
      },
      () => {
        // No tray: the code path in `confirm()` is the only way forward.
      },
    );

    return pairing;
  }

  /**
   * `pair.confirm`: succeeds once the tray gesture has approved, or immediately
   * given the correct 8-character code. Throws `pairingDenied`/`pairingExpired`
   * as appropriate.
   */
  confirm(pairingId: string, code: string | undefined): IssuedPairToken {
    const pairing = this.pending.get(pairingId);
    if (pairing === undefined) {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.pairingExpired, "Unknown or expired pairing.");
    }
    if (Date.now() > pairing.expiresAt && pairing.status === "pending") {
      pairing.status = "expired";
    }
    if (pairing.status === "expired") {
      this.pending.delete(pairingId);
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.pairingExpired, "Pairing request expired.");
    }
    if (pairing.status === "denied") {
      this.pending.delete(pairingId);
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.pairingDenied, "Pairing was denied.");
    }
    if (pairing.status === "pending") {
      if (code === undefined || !constantTimeEqual(code, pairing.code)) {
        throw new BridgeRpcError(
          BRIDGE_ERROR_CODES.pairingDenied,
          "Approval pending; code did not match.",
        );
      }
      pairing.status = "approved";
    }

    this.pending.delete(pairingId);
    return this.issueToken(pairing.clientKind, pairing.scopes);
  }

  private issueToken(clientKind: ClientKind, scopes: readonly string[]): IssuedPairToken {
    const clientId = ulid();
    const exp = Date.now() + PAIR_TOKEN_TTL_MS;
    return { clientId, clientKind, scopes, exp };
  }

  /** Serialises a pair token as `<payload>.<hmac>`, verifiable without server-side storage. */
  encodePairToken(token: IssuedPairToken): string {
    const payload = Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
    return `${payload}.${sign(this.secret, payload)}`;
  }

  verifyPairToken(raw: string): IssuedPairToken {
    const [payload, signature] = raw.split(".");
    if (payload === undefined || signature === undefined) {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.unauthorized, "Malformed pair token.");
    }
    if (!constantTimeEqual(sign(this.secret, payload), signature)) {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.unauthorized, "Invalid pair token signature.");
    }
    let token: IssuedPairToken;
    try {
      token = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IssuedPairToken;
    } catch {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.unauthorized, "Malformed pair token.");
    }
    if (Date.now() > token.exp) {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.unauthorized, "Pair token expired.");
    }
    if (this.revokedClientIds.has(token.clientId)) {
      throw new BridgeRpcError(BRIDGE_ERROR_CODES.forbidden, "Pairing was revoked.");
    }
    return token;
  }

  /** `session.exchange`: trades a valid pair token for a short-lived session token. */
  exchangeForSession(pairTokenRaw: string): {
    sessionToken: string;
    clientId: string;
    scopes: readonly string[];
    exp: number;
  } {
    const token = this.verifyPairToken(pairTokenRaw);
    const exp = Date.now() + SESSION_TOKEN_TTL_MS;
    const session: IssuedPairToken = {
      clientId: token.clientId,
      clientKind: token.clientKind,
      scopes: token.scopes,
      exp,
    };
    return {
      sessionToken: this.encodePairToken(session),
      clientId: token.clientId,
      scopes: token.scopes,
      exp,
    };
  }

  /** Revocation from the tray or the web devices page (B08). */
  revoke(clientId: string): void {
    this.revokedClientIds.add(clientId);
  }

  isRevoked(clientId: string): boolean {
    return this.revokedClientIds.has(clientId);
  }

  /** Diagnostics/tests: number of pairings still awaiting a decision. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Test hook: force-expire a pairing without waiting for the real TTL. */
  expireForTest(pairingId: string): void {
    const pairing = this.pending.get(pairingId);
    if (pairing !== undefined) pairing.expiresAt = 0;
  }

  randomBearerSuffix(): string {
    return randomBytes(8).toString("hex");
  }
}
