/**
 * Sign-in state machine: device-code-style pairing over the bridge (CONTRACTS §5, B08b device
 * flow; bridge pairing per `@montaj/bridge-core`'s `pair.request`/`pair.confirm`/
 * `session.exchange`). The system browser opens for the tray-gesture approval path ("After
 * Effects wants to connect — Allow/Deny", D25); the 8-char code is the fallback when the tray
 * gesture is unavailable (5 attempts, matching THREAT-MODEL T12's lockout — enforced
 * bridge-side; this state machine only surfaces the bridge's `pairingDenied`/`pairingExpired`
 * errors). Same shape as `plugins/premiere-uxp/src/auth/session.ts` (C05a), copied rather than
 * imported for this package's own file boundary, with `clientKind: "ae"` instead of "premiere".
 *
 * SECURITY (THREAT-MODEL T13 / D25): the session is held ONLY in the private field below —
 * never in `localStorage`, `sessionStorage`, or written to disk. A panel reload signs the user
 * out; that is intentional, not a gap — CEP panels are Chromium 99 (THREAT-MODEL T13's own
 * parenthetical), so `window.localStorage` exists here but is deliberately never used for this.
 */
import type { BridgeClient } from "../bridge/client.js";

export interface OpenExternalUrl {
  openExternalUrl(url: string): Promise<void>;
}

export type SignInState =
  | { readonly status: "signedOut" }
  | { readonly status: "requesting" }
  | {
      readonly status: "awaitingApproval";
      readonly pairingId: string;
      readonly code: string | undefined;
      readonly expiresAt: string;
    }
  | { readonly status: "exchanging"; readonly pairingId: string }
  | {
      readonly status: "signedIn";
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly expiresAt: string;
    }
  | { readonly status: "error"; readonly message: string; readonly code?: number };

export type SignInListener = (state: SignInState) => void;

/** Builds the web approval page URL for a pairing id (opened in the system browser). */
export function buildApprovalUrl(origin: string, pairingId: string): string {
  const url = new URL("/pair", origin);
  url.searchParams.set("pairingId", pairingId);
  return url.toString();
}

export class SignInSession {
  private state: SignInState = { status: "signedOut" };
  private sessionToken: string | undefined;
  private readonly listeners = new Set<SignInListener>();

  constructor(
    private readonly bridge: BridgeClient,
    private readonly host: OpenExternalUrl,
    private readonly webOrigin: string,
  ) {}

  getState(): SignInState {
    return this.state;
  }

  /** Bearer token for `POST /transcribe` etc. `undefined` unless signed in. */
  getSessionToken(): string | undefined {
    return this.sessionToken;
  }

  onChange(listener: SignInListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: SignInState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  /** Step 1: request a pairing and open the system browser for tray-gesture approval. */
  async beginSignIn(clientName = "Aksharo Panel (After Effects)"): Promise<void> {
    this.setState({ status: "requesting" });
    try {
      const result = await this.bridge.call("pair.request", {
        clientKind: "ae",
        clientName,
        scopes: ["project:read", "transcribe:create"],
      });
      this.setState({
        status: "awaitingApproval",
        pairingId: result.pairingId,
        code: result.code,
        expiresAt: result.expiresAt,
      });
      await this.host.openExternalUrl(buildApprovalUrl(this.webOrigin, result.pairingId));
    } catch (error) {
      this.setState({ status: "error", message: messageOf(error) });
      throw error;
    }
  }

  /**
   * Step 2: confirm the pairing. Omit `code` for the tray-gesture path once the user reports
   * they approved it in the tray; pass the 8-char code for the fallback UI.
   */
  async confirmSignIn(code?: string): Promise<void> {
    if (this.state.status !== "awaitingApproval") {
      throw new Error(`confirmSignIn called from state "${this.state.status}"`);
    }
    const pairingId = this.state.pairingId;
    this.setState({ status: "exchanging", pairingId });
    try {
      const confirmed = await this.bridge.call("pair.confirm", { pairingId, code });
      const session = await this.bridge.call("session.exchange", {
        pairToken: confirmed.pairToken,
      });
      this.sessionToken = session.sessionToken;
      this.setState({
        status: "signedIn",
        clientId: session.clientId,
        scopes: session.scopes,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      this.setState({ status: "error", message: messageOf(error), code: codeOf(error) });
      throw error;
    }
  }

  /** Drops the in-memory session. Never calls a revoke endpoint on its own (out of scope). */
  signOut(): void {
    this.sessionToken = undefined;
    this.setState({ status: "signedOut" });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Sign-in failed";
}

function codeOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: number }).code
    : undefined;
}
