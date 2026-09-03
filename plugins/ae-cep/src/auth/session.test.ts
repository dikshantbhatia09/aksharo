import { describe, expect, it, vi } from "vitest";

import { SignInSession, buildApprovalUrl } from "./session.js";
import { BridgeClient, MockBridgeTransport } from "../bridge/client.js";
import { BridgeRpcError } from "../bridge/protocol.js";
import { MockAeHost } from "../host/ae.js";

function setup() {
  const transport = new MockBridgeTransport();
  const client = new BridgeClient(transport);
  const host = new MockAeHost();
  const session = new SignInSession(client, host, "https://aksharo.ai");
  return { transport, client, host, session };
}

describe("buildApprovalUrl", () => {
  it("builds a /pair URL with the pairing id", () => {
    expect(buildApprovalUrl("https://aksharo.ai", "pair-123")).toBe(
      "https://aksharo.ai/pair?pairingId=pair-123",
    );
  });
});

describe("SignInSession", () => {
  it("starts signed out", () => {
    const { session } = setup();
    expect(session.getState()).toEqual({ status: "signedOut" });
    expect(session.getSessionToken()).toBeUndefined();
  });

  it("beginSignIn opens the approval URL and moves to awaitingApproval", async () => {
    const { transport, host, session } = setup();
    transport.on("pair.request", () => ({
      pairingId: "pair-1",
      code: "ABCD2345",
      expiresAt: "2026-09-03T00:01:00.000Z",
    }));

    await session.beginSignIn();

    expect(session.getState()).toEqual({
      status: "awaitingApproval",
      pairingId: "pair-1",
      code: "ABCD2345",
      expiresAt: "2026-09-03T00:01:00.000Z",
    });
    expect(host.openedUrls).toEqual(["https://aksharo.ai/pair?pairingId=pair-1"]);
  });

  it("confirmSignIn exchanges the pair token for a session and stores it only in memory", async () => {
    const { transport, session } = setup();
    transport.on("pair.request", () => ({ pairingId: "pair-1", expiresAt: "later" }));
    transport.on("pair.confirm", (params) => {
      expect(params).toEqual({ pairingId: "pair-1", code: "ABCD2345" });
      return { pairToken: "pt-1", clientId: "client-1", scopes: ["project:read"], expiresAt: "e1" };
    });
    transport.on("session.exchange", (params) => {
      expect(params).toEqual({ pairToken: "pt-1" });
      return {
        sessionToken: "sess-1",
        clientId: "client-1",
        scopes: ["project:read"],
        expiresAt: "e2",
      };
    });

    await session.beginSignIn();
    await session.confirmSignIn("ABCD2345");

    expect(session.getState()).toEqual({
      status: "signedIn",
      clientId: "client-1",
      scopes: ["project:read"],
      expiresAt: "e2",
    });
    expect(session.getSessionToken()).toBe("sess-1");
  });

  it("confirmSignIn without a code supports the tray-gesture path", async () => {
    const { transport, session } = setup();
    transport.on("pair.request", () => ({ pairingId: "pair-1", expiresAt: "later" }));
    transport.on("pair.confirm", (params) => {
      expect(params).toEqual({ pairingId: "pair-1", code: undefined });
      return { pairToken: "pt-1", clientId: "client-1", scopes: [], expiresAt: "e1" };
    });
    transport.on("session.exchange", () => ({
      sessionToken: "sess-1",
      clientId: "client-1",
      scopes: [],
      expiresAt: "e2",
    }));

    await session.beginSignIn();
    await session.confirmSignIn();

    expect(session.getState().status).toBe("signedIn");
  });

  it("confirmSignIn rejects when not awaitingApproval", async () => {
    const { session } = setup();
    await expect(session.confirmSignIn("X")).rejects.toThrow(/awaitingApproval|signedOut/);
  });

  it("surfaces a pairingDenied error and returns to an error state", async () => {
    const { transport, session } = setup();
    transport.on("pair.request", () => ({ pairingId: "pair-1", expiresAt: "later" }));
    transport.on("pair.confirm", () => {
      throw new BridgeRpcError(-32004, "pairing denied");
    });

    await session.beginSignIn();
    await expect(session.confirmSignIn("ABCD2345")).rejects.toThrow("pairing denied");
    expect(session.getState()).toEqual({
      status: "error",
      message: "pairing denied",
      code: -32004,
    });
  });

  it("signOut drops the in-memory token and returns to signedOut", async () => {
    const { transport, session } = setup();
    transport.on("pair.request", () => ({ pairingId: "pair-1", expiresAt: "later" }));
    transport.on("pair.confirm", () => ({
      pairToken: "pt-1",
      clientId: "c1",
      scopes: [],
      expiresAt: "e1",
    }));
    transport.on("session.exchange", () => ({
      sessionToken: "sess-1",
      clientId: "c1",
      scopes: [],
      expiresAt: "e2",
    }));
    await session.beginSignIn();
    await session.confirmSignIn();

    session.signOut();

    expect(session.getState()).toEqual({ status: "signedOut" });
    expect(session.getSessionToken()).toBeUndefined();
  });

  it("notifies onChange listeners on every transition", async () => {
    const { transport, session } = setup();
    transport.on("pair.request", () => ({ pairingId: "pair-1", expiresAt: "later" }));
    const listener = vi.fn();
    session.onChange(listener);

    await session.beginSignIn();

    expect(listener).toHaveBeenCalledWith({ status: "requesting" });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "awaitingApproval" }));
  });
});
