import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App.js";
import { BridgeClient, MockBridgeTransport } from "../bridge/client.js";
import { MockPremiereHost } from "../host/premiere.js";

import type { HttpClient } from "../upload/mixdown.js";

class StubHttpClient implements HttpClient {
  async putBinary(): Promise<void> {}
  async postJson<T>(): Promise<T> {
    return { projectId: "proj-1", webEditorUrl: "https://aksharo.ai/p/proj-1" } as T;
  }
}

function renderApp(transport = new MockBridgeTransport()) {
  const bridge = new BridgeClient(transport);
  const host = new MockPremiereHost();
  const http = new StubHttpClient();
  render(
    <App
      host={host}
      bridge={bridge}
      http={http}
      apiOrigin="https://api.aksharo.ai"
      webOrigin="https://aksharo.ai"
      panelVersion="0.1.0"
      apiVersion="1"
      activationState="active"
      updateBannerState={{ show: false, severity: "none" }}
    />,
  );
  return { transport, bridge, host };
}

describe("App", () => {
  it("shows the sign-in screen when signed out", () => {
    renderApp();
    expect(screen.getByTestId("sign-in-signed-out")).toBeInTheDocument();
  });

  it("shows the activation badge from props", () => {
    renderApp();
    expect(screen.getByTestId("activation-badge")).toHaveAttribute("data-state", "active");
  });

  it("shows the footer version line", () => {
    renderApp();
    expect(screen.getByTestId("footer-version-line")).toHaveTextContent("Aksharo Panel v0.1.0");
  });

  it("signs in (tray-gesture path) and shows the project panel with the sequence name", async () => {
    const transport = new MockBridgeTransport();
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
    const user = userEvent.setup();
    renderApp(transport);

    await user.click(screen.getByRole("button", { name: /sign in with aksharo/i }));
    await waitFor(() => expect(screen.getByTestId("sign-in-awaiting")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /i approved it/i }));
    await waitFor(() => expect(screen.getByTestId("project-panel")).toBeInTheDocument());
    expect(screen.getByText("Mock Sequence")).toBeInTheDocument();
  });

  it("runs the transcribe flow end to end and shows the open-in-web link", async () => {
    const transport = new MockBridgeTransport();
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
    transport.on("media.uploadTicket", () => ({
      uploadUrl: "https://r2.example/put",
      expiresAt: "later",
    }));
    const user = userEvent.setup();
    renderApp(transport);

    await user.click(screen.getByRole("button", { name: /sign in with aksharo/i }));
    await user.click(await screen.findByRole("button", { name: /i approved it/i }));
    await screen.findByTestId("project-panel");

    await user.click(screen.getByRole("button", { name: /transcribe this sequence/i }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /open in the web editor/i })).toHaveAttribute(
        "href",
        "https://aksharo.ai/p/proj-1",
      ),
    );
  });
});
