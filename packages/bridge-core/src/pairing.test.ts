import { describe, expect, it, vi } from "vitest";

import { NO_TRAY_GESTURE, PairingService, type TrayGesture } from "./pairing.js";

describe("PairingService — code fallback", () => {
  it("issues a pair token when the correct code is submitted", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("desktop", "Aksharo Desktop", ["apply.write"]);
    const issued = service.confirm(pairing.pairingId, pairing.code);
    expect(issued.clientKind).toBe("desktop");
    expect(issued.scopes).toEqual(["apply.write"]);
    expect(issued.exp).toBeGreaterThan(Date.now());
  });

  it("denies confirmation with a wrong code", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("premiere", "Premiere Panel", []);
    expect(() => service.confirm(pairing.pairingId, "WRONGCOD")).toThrow(/pending|denied/i);
  });

  it("expires a pairing request past its TTL", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("web", "Browser", []);
    service.expireForTest(pairing.pairingId);
    expect(() => service.confirm(pairing.pairingId, pairing.code)).toThrow(/expired/i);
  });

  it("rejects confirmation of an unknown pairing id", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    expect(() => service.confirm("nonexistent", "AAAAAAAA")).toThrow(/expired|unknown/i);
  });
});

describe("PairingService — tray gesture", () => {
  it("approves without a code once the tray gesture resolves", async () => {
    let resolveGesture: (v: "approved" | "denied") => void = () => undefined;
    const tray: TrayGesture = {
      requestApproval: () => new Promise((resolve) => (resolveGesture = resolve)),
    };
    const service = new PairingService("secret", tray);
    const pairing = service.request("ae", "AE Panel", []);
    resolveGesture("approved");
    await vi.waitFor(() => {
      const issued = service.confirm(pairing.pairingId, undefined);
      expect(issued.clientKind).toBe("ae");
    });
  });

  it("denies when the tray gesture is denied", async () => {
    const tray: TrayGesture = { requestApproval: () => Promise.resolve("denied") };
    const service = new PairingService("secret", tray);
    const pairing = service.request("desktop", "Desktop", []);
    await vi.waitFor(() => {
      expect(() => service.confirm(pairing.pairingId, undefined)).toThrow(/denied/i);
    });
  });
});

describe("PairingService — tokens", () => {
  it("round-trips encode/verify and rejects a tampered token", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("desktop", "Desktop", ["scope.a"]);
    const issued = service.confirm(pairing.pairingId, pairing.code);
    const token = service.encodePairToken(issued);
    const verified = service.verifyPairToken(token);
    expect(verified.clientId).toBe(issued.clientId);

    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => service.verifyPairToken(tampered)).toThrow(/signature/i);
  });

  it("rejects a token signed with a different secret", () => {
    const a = new PairingService("secret-a", NO_TRAY_GESTURE);
    const b = new PairingService("secret-b", NO_TRAY_GESTURE);
    const pairing = a.request("desktop", "Desktop", []);
    const issued = a.confirm(pairing.pairingId, pairing.code);
    const token = a.encodePairToken(issued);
    expect(() => b.verifyPairToken(token)).toThrow();
  });

  it("session.exchange trades a pair token for a session token", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("desktop", "Desktop", ["scope.a"]);
    const issued = service.confirm(pairing.pairingId, pairing.code);
    const pairToken = service.encodePairToken(issued);
    const session = service.exchangeForSession(pairToken);
    expect(session.clientId).toBe(issued.clientId);
    expect(session.scopes).toEqual(["scope.a"]);
  });

  it("revocation makes a previously valid pair token fail verification", () => {
    const service = new PairingService("secret", NO_TRAY_GESTURE);
    const pairing = service.request("desktop", "Desktop", []);
    const issued = service.confirm(pairing.pairingId, pairing.code);
    const token = service.encodePairToken(issued);
    service.revoke(issued.clientId);
    expect(() => service.verifyPairToken(token)).toThrow(/revoked/i);
  });
});
