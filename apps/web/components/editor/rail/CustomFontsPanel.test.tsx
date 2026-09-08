import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomFontsPanel } from "./CustomFontsPanel";

import type { FontUploadTicket, WorkspaceFontView } from "./fonts-endpoints";

import { renderWithProviders } from "@/test/harness";

const WORKSPACE_ID = "01JWORKSPACE";

const READY_FONT: WorkspaceFontView = {
  id: "01JFONT1",
  workspaceId: WORKSPACE_ID,
  family: "Brand Sans",
  style: "regular",
  status: "ready",
  sanitised: true,
  weight: 400,
  italic: false,
  scripts: ["latin", "devanagari"],
  sizeBytes: 204_800,
  woff2SizeBytes: 51_200,
  filename: "brand-sans.ttf",
  licenceAttestedBy: "01JUSER",
  attestedAt: "2026-09-01T00:00:00.000Z",
  attestationVersion: "1",
  licenceNote: null,
  servedOnlyToWorkspace: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const UPLOAD_TICKET: FontUploadTicket = {
  fontId: "01JFONT2",
  url: "https://storage.test/fonts/01JFONT2.ttf?sig=abc",
  key: "ws/01JWORKSPACE/fonts/01JFONT2.ttf",
  expiresAt: "2026-09-08T00:10:00.000Z",
  attestation: {
    version: "1",
    text: "You warrant you are licensed to embed this font in exported video.",
  },
  quota: { used: 1, limit: 5, planKey: "creator" },
  font: {
    ...READY_FONT,
    id: "01JFONT2",
    status: "pending",
    sanitised: false,
    sizeBytes: 100_000,
    woff2SizeBytes: null,
  },
};

function makeFile(name: string, sizeBytes: number, type = "font/ttf"): File {
  const file = new File([new Uint8Array(Math.min(sizeBytes, 1024))], name, { type });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<CustomFontsPanel />", () => {
  it("lists the workspace's existing fonts", async () => {
    renderWithProviders(<CustomFontsPanel />, {
      routes: { [`/workspaces/${WORKSPACE_ID}/fonts`]: [READY_FONT] },
    });
    expect(await screen.findByText("Brand Sans")).toBeInTheDocument();
    expect(screen.getByTestId("custom-fonts-row")).toHaveAttribute("data-status", "ready");
  });

  it("says so when there are none yet", async () => {
    renderWithProviders(<CustomFontsPanel />, {
      routes: { [`/workspaces/${WORKSPACE_ID}/fonts`]: [] },
    });
    expect(await screen.findByText("No custom fonts yet.")).toBeInTheDocument();
  });

  it("uploads a font end to end: init, PUT the bytes, attest, complete", async () => {
    const user = userEvent.setup();
    const putSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", putSpy);

    const { fetchMock } = renderWithProviders(<CustomFontsPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/fonts`]: [],
        [`/workspaces/${WORKSPACE_ID}/fonts/init`]: UPLOAD_TICKET,
        [`/workspaces/${WORKSPACE_ID}/fonts/${UPLOAD_TICKET.fontId}/complete`]: {
          ...READY_FONT,
          id: UPLOAD_TICKET.fontId,
        },
      },
    });

    await screen.findByText("No custom fonts yet.");

    const file = makeFile("brand-sans.ttf", 100_000);
    const input = screen.getByTestId("custom-fonts-file-input") as HTMLInputElement;
    await user.upload(input, file);

    // The attestation step shows the server's own warranty text and blocks
    // "Add font" until the checkbox is ticked.
    await screen.findByTestId("custom-fonts-attestation");
    expect(screen.getByText(UPLOAD_TICKET.attestation.text)).toBeInTheDocument();
    expect(screen.getByTestId("custom-fonts-confirm-button")).toBeDisabled();

    await user.click(screen.getByTestId("custom-fonts-attest-checkbox"));
    expect(screen.getByTestId("custom-fonts-confirm-button")).not.toBeDisabled();
    await user.click(screen.getByTestId("custom-fonts-confirm-button"));

    // The raw bytes went straight to the presigned URL, not through the API client.
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledWith(
        UPLOAD_TICKET.url,
        expect.objectContaining({ method: "PUT", body: file }),
      );
    });

    // `complete` was called with the attestation, through the real API client.
    await waitFor(() => {
      const completeCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes(`/fonts/${UPLOAD_TICKET.fontId}/complete`),
      );
      expect(completeCall).toBeDefined();
    });

    // The dialog closes back to idle once the font is added.
    await waitFor(() => {
      expect(screen.queryByTestId("custom-fonts-attestation")).toBeNull();
    });
  });

  it("shows the server's own message when the upload is refused (e.g. plan limit)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    renderWithProviders(<CustomFontsPanel />, {
      routes: {
        [`/workspaces/${WORKSPACE_ID}/fonts`]: [],
        [`/workspaces/${WORKSPACE_ID}/fonts/init`]: new Response(
          JSON.stringify({
            error: {
              code: "fonts/plan_limit_reached",
              message: "This plan allows 5 custom fonts.",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      },
    });

    await screen.findByText("No custom fonts yet.");
    const file = makeFile("brand-sans.ttf", 100_000);
    await user.upload(screen.getByTestId("custom-fonts-file-input"), file);

    expect(await screen.findByTestId("custom-fonts-error")).toHaveTextContent(
      "This plan allows 5 custom fonts.",
    );
  });

  it("refuses an oversized file before ever calling the server", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<CustomFontsPanel />, {
      routes: { [`/workspaces/${WORKSPACE_ID}/fonts`]: [] },
    });
    await screen.findByText("No custom fonts yet.");

    const tooBig = makeFile("huge.ttf", 9 * 1024 * 1024);
    await user.upload(screen.getByTestId("custom-fonts-file-input"), tooBig);

    expect(await screen.findByTestId("custom-fonts-error")).toHaveTextContent("8 MB");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/fonts/init"))).toBe(
      false,
    );
  });
});
