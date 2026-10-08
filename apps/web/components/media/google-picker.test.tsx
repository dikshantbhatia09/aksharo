import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GooglePickerButton } from "./google-picker";

describe("<GooglePickerButton />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).gapi;
    delete (window as any).google;
  });

  it("renders Google Drive button", () => {
    const onFileSelected = vi.fn();
    render(<GooglePickerButton onFileSelected={onFileSelected} />);

    expect(screen.getByTestId("google-picker-button")).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
  });

  it("triggers OAuth token flow and opens picker on click", async () => {
    const user = userEvent.setup();
    const onFileSelected = vi.fn();

    // Mock gapi
    (window as any).gapi = {
      load: vi.fn((api, cb) => cb()),
    };

    const mockRequestAccessToken = vi.fn();
    let tokenCallback: (resp: any) => void = () => {};

    // Mock google identity & picker
    const mockBuild = vi.fn().mockReturnValue({ setVisible: vi.fn() });
    const mockSetVisible = vi.fn();
    const mockPickerBuilder = vi.fn().mockImplementation(() => ({
      addView: vi.fn().mockReturnThis(),
      setOAuthToken: vi.fn().mockReturnThis(),
      setDeveloperKey: vi.fn().mockReturnThis(),
      setCallback: vi.fn().mockImplementation((cb) => {
        // simulate picker returning a chosen file
        setTimeout(() => {
          cb({
            action: "picked",
            docs: [
              {
                id: "drive-file-123",
                name: "interview_raw.mp4",
                sizeBytes: 104857600,
                mimeType: "video/mp4",
              },
            ],
          });
        }, 10);
        return this;
      }),
      enableFeature: vi.fn().mockReturnThis(),
      setTitle: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ setVisible: mockSetVisible }),
    }));

    (window as any).google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn().mockImplementation((config) => {
            tokenCallback = config.callback;
            return {
              requestAccessToken: () => {
                tokenCallback({ access_token: "mock-oauth-token" });
              },
            };
          }),
        },
      },
      picker: {
        PickerBuilder: mockPickerBuilder,
        ViewId: { DOCS_VIDEOS: "DOCS_VIDEOS" },
        Feature: { SUPPORT_DRIVES: "SUPPORT_DRIVES", NAV_HIDDEN: "NAV_HIDDEN" },
        Action: { PICKED: "picked", CANCEL: "cancel" },
        Response: { DOCUMENTS: "docs", ACTION: "action" },
        Document: { ID: "id", NAME: "name", SIZE_BYTES: "sizeBytes", MIME_TYPE: "mimeType" },
      },
    };

    render(
      <GooglePickerButton
        onFileSelected={onFileSelected}
        clientId="mock-client-id"
        apiKey="mock-api-key"
      />,
    );

    await user.click(screen.getByTestId("google-picker-button"));

    await waitFor(() => {
      expect(onFileSelected).toHaveBeenCalledWith({
        provider: "GOOGLE_DRIVE",
        fileId: "drive-file-123",
        fileName: "interview_raw.mp4",
        fileSizeBytes: 104857600,
        mimeType: "video/mp4",
        token: "mock-oauth-token",
      });
    });
  });
});

