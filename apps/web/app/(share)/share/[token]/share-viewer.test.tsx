import { fireEvent, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ShareViewer } from "./share-viewer";

import { renderWithProviders } from "@/test/harness";

// `CaptionStage` needs CanvasKit/wasm, which A15/A17 already test on their
// own; this suite is about the surrounding viewer (gating, comments, report,
// decision), so the stage is replaced with a marker.
vi.mock("@/components/editor/canvas/CaptionStage", () => ({
  CaptionStage: ({ src }: { src: string }) => <div data-testid="fake-caption-stage">{src}</div>,
}));

const TOKEN = "abc123def456ghi789jklmno";

const RESOLVE_VIEW = {
  projectId: "01JPROJECT0000000000000AA",
  title: "Diwali promo",
  scope: "view",
  requiresPassword: false,
  unlocked: true,
  expired: false,
  revoked: false,
  reviewStatus: "none",
  aspect: "9:16",
};

const PREVIEW = {
  proxyUrl: "https://cdn.example.test/proxy.mp4",
  durationMs: 60_000,
  aspect: "9:16",
  projection: {
    canvas: { width: 1080, height: 1920 },
    styles: { defaultStyleId: "system:default" },
    segments: [],
    words: [],
  },
};

describe("ShareViewer", () => {
  it("renders the title and the (mocked) preview once resolved", async () => {
    renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: RESOLVE_VIEW,
        [`/s/${TOKEN}/preview`]: PREVIEW,
        [`/s/${TOKEN}/comments`]: [],
      },
    });

    await screen.findByTestId("share-title");
    expect(screen.getByTestId("share-title")).toHaveTextContent("Diwali promo");
    await screen.findByTestId("fake-caption-stage");
  });

  it("shows a password gate and unlocks with the right password", async () => {
    const { fetchMock } = renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: { ...RESOLVE_VIEW, requiresPassword: true, unlocked: false },
        [`/s/${TOKEN}/unlock`]: { session: "signed-session-value" },
      },
    });

    await screen.findByTestId("share-password-input");
    fireEvent.change(screen.getByTestId("share-password-input"), {
      target: { value: "correcthorsebattery" },
    });
    fireEvent.click(screen.getByText("Unlock"));

    await waitFor(() => {
      const unlockCall = fetchMock.mock.calls.find(([input]) =>
        new URL(String(input)).pathname.endsWith("/unlock"),
      );
      expect(unlockCall).toBeDefined();
    });
  });

  it("does not offer comments on a view-only link", async () => {
    renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: RESOLVE_VIEW,
        [`/s/${TOKEN}/preview`]: PREVIEW,
        [`/s/${TOKEN}/comments`]: [],
      },
    });

    await screen.findByTestId("share-comments");
    expect(screen.queryByTestId("comment-body")).not.toBeInTheDocument();
  });

  it("offers comments and the decision bar on an approve-scope link", async () => {
    renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: { ...RESOLVE_VIEW, scope: "approve" },
        [`/s/${TOKEN}/preview`]: PREVIEW,
        [`/s/${TOKEN}/comments`]: [],
      },
    });

    await screen.findByTestId("share-decision-bar");
    expect(screen.getByTestId("comment-body")).toBeInTheDocument();
  });

  it("submits a report and shows the acknowledgement", async () => {
    renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: RESOLVE_VIEW,
        [`/s/${TOKEN}/preview`]: PREVIEW,
        [`/s/${TOKEN}/comments`]: [],
        [`/s/${TOKEN}/report`]: {
          id: "01JREPORT0000000000000AA",
          dueAt: "2026-09-05T00:00:00.000Z",
        },
      },
    });

    await screen.findByTestId("report-abuse-open");
    fireEvent.click(screen.getByTestId("report-abuse-open"));
    fireEvent.click(screen.getByTestId("report-abuse-form").querySelector("button[type=submit]")!);

    await screen.findByTestId("report-abuse-ack");
  });

  it("shows a not-found message for a revoked link", async () => {
    renderWithProviders(<ShareViewer token={TOKEN} />, {
      accessToken: null,
      routes: {
        [`/s/${TOKEN}`]: new Response(
          JSON.stringify({ error: { code: "share/revoked", message: "Revoked." } }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
      },
    });

    await screen.findByTestId("share-error");
    expect(screen.getByTestId("share-error")).toHaveTextContent("disabled by its owner");
  });
});
