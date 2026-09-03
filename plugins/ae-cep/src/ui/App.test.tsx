import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import { App } from "./App.js";
import { applyCaptions } from "../apply/applyCaptions.js";
import { BridgeClient, MockBridgeTransport } from "../bridge/client.js";
import { MockAeHost } from "../host/ae.js";

import type { HttpClient } from "../upload/mixdown.js";

class StubHttpClient implements HttpClient {
  async putBinary(): Promise<void> {}
  async postJson<T>(): Promise<T> {
    return { projectId: "proj-1", webEditorUrl: "https://aksharo.ai/p/proj-1" } as T;
  }
}

function renderApp(transport = new MockBridgeTransport()) {
  const bridge = new BridgeClient(transport);
  const host = new MockAeHost();
  const http = new StubHttpClient();
  // Test-only wiring for `onApplyCaptions` — see `App.tsx`'s doc comment on why the production
  // bundle (`src/index.tsx`) never imports `applyCaptions`/`@montaj/caption-styles` directly.
  const onApplyCaptions = () =>
    applyCaptions(host, {
      projectId: "proj-1",
      rev: 1,
      compId: "comp-mock-1",
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: loadSystemStyles().find((s) => s.id === "subtitle-classic")!,
      segments: [{ segmentId: "seg-1", text: "Aksharo caption", startSeconds: 0, endSeconds: 2 }],
      overlaySourcePath: "/tmp/aksharo-overlay.mov",
    });
  render(
    <App
      host={host}
      bridge={bridge}
      http={http}
      apiOrigin="https://api.aksharo.ai"
      webOrigin="https://aksharo.ai"
      panelVersion="0.1.0"
      onApplyCaptions={onApplyCaptions}
    />,
  );
  return { transport, bridge, host };
}

function withSignInHandlers(transport: MockBridgeTransport): void {
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
}

describe("App", () => {
  it("shows the sign-in screen when signed out", () => {
    renderApp();
    expect(screen.getByTestId("sign-in-signed-out")).toBeInTheDocument();
  });

  it("shows the footer version line", () => {
    renderApp();
    expect(screen.getByTestId("footer-version-line")).toHaveTextContent("Aksharo Panel v0.1.0");
  });

  it("signs in (tray-gesture path) and shows the comp panel with the comp name", async () => {
    const transport = new MockBridgeTransport();
    withSignInHandlers(transport);
    const user = userEvent.setup();
    renderApp(transport);

    await user.click(screen.getByRole("button", { name: /sign in with aksharo/i }));
    await waitFor(() => expect(screen.getByTestId("sign-in-awaiting")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /i approved it/i }));
    await waitFor(() => expect(screen.getByTestId("comp-panel")).toBeInTheDocument());
    expect(screen.getByText("Mock Comp")).toBeInTheDocument();
  });

  it("runs the caption flow end to end, then applies captions as styled text layers", async () => {
    const transport = new MockBridgeTransport();
    withSignInHandlers(transport);
    transport.on("media.uploadTicket", () => ({
      uploadUrl: "https://r2.example/put",
      expiresAt: "later",
    }));
    const user = userEvent.setup();
    renderApp(transport);

    await user.click(screen.getByRole("button", { name: /sign in with aksharo/i }));
    await user.click(await screen.findByRole("button", { name: /i approved it/i }));
    await screen.findByTestId("comp-panel");

    await user.click(screen.getByRole("button", { name: /caption this comp/i }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /open in the web editor/i })).toHaveAttribute(
        "href",
        "https://aksharo.ai/p/proj-1",
      ),
    );

    await user.click(screen.getByRole("button", { name: /apply captions/i }));
    await waitFor(() =>
      expect(screen.getByTestId("apply-result")).toHaveTextContent(/Styled text layers/),
    );
  });
});
