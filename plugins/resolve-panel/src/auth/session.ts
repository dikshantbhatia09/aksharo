/**
 * Sign-in state mirrored from the script's own bridge session (brief item 1: "sign-in state
 * mirrored from the script"), not a device-code flow this panel runs itself — the script
 * (`aksharo_core_app/bridge/device_auth.py`, B08b) is the one process that talks to the
 * API's device-code endpoints; this panel only polls `session.status`
 * (`aksharo_core_app/session.py`'s wire shape) and renders it.
 *
 * THREAT-MODEL.md T13 / D25 ("panels keep tokens in memory only") does not even apply here —
 * this panel never holds a token at all, unlike C05a's UXP panel — but the same "no
 * persistence" discipline is kept for the mirrored state below.
 */

export interface PairingInfo {
  readonly userCode: string;
  readonly verificationUrl: string;
}

export interface SessionStatus {
  readonly signedIn: boolean;
  readonly workspaceId: string | null;
  readonly userEmail: string | null;
  readonly pairing: PairingInfo | null;
}

/** `session.status`'s raw JSON-RPC result shape (`session.py`'s `SessionState.to_wire()`). */
export interface SessionStatusWire {
  readonly signedIn: boolean;
  readonly workspaceId: string | null;
  readonly userEmail: string | null;
  readonly pairing: { readonly userCode: string; readonly verificationUrl: string } | null;
}

export function parseSessionStatus(wire: SessionStatusWire): SessionStatus {
  return {
    signedIn: wire.signedIn,
    workspaceId: wire.workspaceId,
    userEmail: wire.userEmail,
    pairing: wire.pairing
      ? { userCode: wire.pairing.userCode, verificationUrl: wire.pairing.verificationUrl }
      : null,
  };
}

export const SIGNED_OUT_STATUS: SessionStatus = {
  signedIn: false,
  workspaceId: null,
  userEmail: null,
  pairing: null,
};
