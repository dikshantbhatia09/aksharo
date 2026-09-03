import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App.js";
import { MockWorkflowIntegrationHost, type DiscoveryFile } from "../host/workflow-integration.js";
import { MockRpcTransport } from "../rpc/client.js";

const DISCOVERY: DiscoveryFile = {
  port: 47841,
  bearer: "secret-token",
  pid: 1,
  version: "0.1.0",
  startedAt: "2026-01-01T00:00:00Z",
};

const NO_BANNER = { show: false as const, severity: "none" as const };

function baseTransport(overrides: Partial<Record<string, () => unknown>> = {}): MockRpcTransport {
  const transport = new MockRpcTransport();
  transport.on(
    "session.status",
    overrides["session.status"] ??
      (() => ({
        signedIn: true,
        workspaceId: "ws_1",
        userEmail: "creator@example.com",
        pairing: null,
      })),
  );
  transport.on(
    "timeline.current",
    overrides["timeline.current"] ?? (() => ({ timeline: { name: "Timeline 1", fps: 25 } })),
  );
  transport.on("passes.list", overrides["passes.list"] ?? (() => ({ passes: [] })));
  return transport;
}

describe("App", () => {
  it("shows the Studio-required guard on a Free install", async () => {
    const host = new MockWorkflowIntegrationHost({ isStudio: false });
    render(
      <App
        host={host}
        createTransport={() => new MockRpcTransport()}
        panelVersion="0.1.0"
        apiVersion="0.1.0"
        updateBannerState={NO_BANNER}
        projectId="proj_1"
        languageHints={["en"]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("studio-required")).toBeInTheDocument());
  });

  it("shows waiting-for-script until the discovery file appears, with a working retry", async () => {
    const host = new MockWorkflowIntegrationHost();
    const transport = baseTransport();
    render(
      <App
        host={host}
        createTransport={() => transport}
        panelVersion="0.1.0"
        apiVersion="0.1.0"
        updateBannerState={NO_BANNER}
        projectId="proj_1"
        languageHints={["en"]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("waiting-for-script")).toBeInTheDocument());

    host.setDiscoveryFile(DISCOVERY);
    await userEvent.click(screen.getByTestId("retry-connect"));

    await waitFor(() => expect(screen.getByTestId("timeline-name")).toBeInTheDocument());
  });

  it("shows sign-in pairing when not yet signed in, once connected", async () => {
    const host = new MockWorkflowIntegrationHost({ discoveryFile: DISCOVERY });
    const transport = baseTransport({
      "session.status": () => ({
        signedIn: false,
        workspaceId: null,
        userEmail: null,
        pairing: { userCode: "4F7K-92QA", verificationUrl: "https://aksharo.ai/device" },
      }),
    });
    render(
      <App
        host={host}
        createTransport={() => transport}
        panelVersion="0.1.0"
        apiVersion="0.1.0"
        updateBannerState={NO_BANNER}
        projectId="proj_1"
        languageHints={["en"]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("sign-in-pairing")).toBeInTheDocument());
    expect(screen.getByTestId("sign-in-open-url").textContent).toBe("4F7K-92QA");
  });

  it("once signed in and connected, transcribes the timeline and lists passes", async () => {
    const host = new MockWorkflowIntegrationHost({ discoveryFile: DISCOVERY });
    let transcribeCalls = 0;
    const transport = baseTransport({
      "passes.list": () => ({
        passes: [
          {
            passId: "pass_1",
            type: "autocut",
            items: [{ itemId: "item_1", kind: "cut", state: "accepted" }],
          },
        ],
      }),
    });
    transport.on("transcribe.start", () => {
      transcribeCalls += 1;
      return { projectId: "proj_1" };
    });
    transport.on("apply.begin", () => ({ transactionId: "t1" }));
    transport.on("apply.step", () => ({ accepted: true }));
    transport.on("apply.commit", () => ({ appliedSteps: 1 }));

    render(
      <App
        host={host}
        createTransport={() => transport}
        panelVersion="0.1.0"
        apiVersion="0.1.0"
        updateBannerState={NO_BANNER}
        projectId="proj_1"
        languageHints={["en"]}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("timeline-name")).toBeInTheDocument());
    expect(screen.getByTestId("pass-item-item_1")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("transcribe-button"));
    await waitFor(() => expect(transcribeCalls).toBe(1));

    await userEvent.click(screen.getByTestId("apply-button"));
    await waitFor(() =>
      expect(transport.calls.some((c) => c.method === "apply.commit")).toBe(true),
    );
  });

  it("shows a connection error and can retry", async () => {
    const host = new MockWorkflowIntegrationHost({ discoveryFile: DISCOVERY });
    const transport = new MockRpcTransport();
    transport.on("session.status", () => {
      throw new Error("loopback closed");
    });
    render(
      <App
        host={host}
        createTransport={() => transport}
        panelVersion="0.1.0"
        apiVersion="0.1.0"
        updateBannerState={NO_BANNER}
        projectId="proj_1"
        languageHints={["en"]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("connection-error")).toBeInTheDocument());
  });
});
