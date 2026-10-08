import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as React from "react";
import { EMPTY_START_FORM, SourceStartForm, type StartFormValue } from "./SourceStartForm";

function Harness({
  initialValue = { ...EMPTY_START_FORM, tab: "upload" },
  onCloudFileSelected,
}: {
  initialValue?: StartFormValue;
  onCloudFileSelected?: (file: any) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>(initialValue);
  return (
    <SourceStartForm
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      onCloudFileSelected={onCloudFileSelected}
    />
  );
}

describe("<SourceStartForm /> cloud storage connectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY = "mock-api-key";
    delete (window as any).Dropbox;
    delete (window as any).google;
    delete (window as any).gapi;
  });

  it("renders Google Drive and Dropbox buttons on upload tab", () => {
    render(<Harness />);
    expect(screen.getByText("Or import from cloud storage:")).toBeInTheDocument();
    expect(screen.getByTestId("google-picker-button")).toBeInTheDocument();
    expect(screen.getByTestId("dropbox-chooser-button")).toBeInTheDocument();
  });

  it("selects a file via Google Drive and sets form state", async () => {
    const user = userEvent.setup();
    const onCloudFileSelected = vi.fn();

    (window as any).gapi = {
      load: vi.fn((api, cb) => cb()),
    };

    let tokenCallback: (resp: any) => void = () => {};
    const mockPickerBuilder = vi.fn().mockImplementation(() => ({
      addView: vi.fn().mockReturnThis(),
      setOAuthToken: vi.fn().mockReturnThis(),
      setDeveloperKey: vi.fn().mockReturnThis(),
      setCallback: vi.fn().mockImplementation((cb) => {
        setTimeout(() => {
          cb({
            action: "picked",
            docs: [
              {
                id: "drive-999",
                name: "team_podcast.mp4",
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
      build: vi.fn().mockReturnValue({ setVisible: vi.fn() }),
    }));

    (window as any).google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn().mockImplementation((config) => {
            tokenCallback = config.callback;
            return {
              requestAccessToken: () => {
                tokenCallback({ access_token: "drive-access-token" });
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

    render(<Harness onCloudFileSelected={onCloudFileSelected} />);

    await user.click(screen.getByTestId("google-picker-button"));

    await waitFor(() => {
      expect(onCloudFileSelected).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "GOOGLE_DRIVE",
          fileId: "drive-999",
          fileName: "team_podcast.mp4",
        }),
      );
      expect(screen.getByTestId("selected-file")).toHaveTextContent("team_podcast.mp4");
    });
  });

  it("selects a file via Dropbox and sets form state", async () => {
    const user = userEvent.setup();
    const onCloudFileSelected = vi.fn();

    (window as any).Dropbox = {
      isBrowserSupported: vi.fn().mockReturnValue(true),
      choose: vi.fn().mockImplementation((options) => {
        options.success([
          {
            id: "id:drop-555",
            name: "dropbox_clip.mov",
            bytes: 52428800,
            link: "https://dl.dropboxusercontent.com/s/123/dropbox_clip.mov",
          },
        ]);
      }),
    };

    render(<Harness onCloudFileSelected={onCloudFileSelected} />);

    await user.click(screen.getByTestId("dropbox-chooser-button"));

    await waitFor(() => {
      expect(onCloudFileSelected).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "DROPBOX",
          fileId: "id:drop-555",
          fileName: "dropbox_clip.mov",
          downloadUrl: "https://dl.dropboxusercontent.com/s/123/dropbox_clip.mov",
        }),
      );
      expect(screen.getByTestId("selected-file")).toHaveTextContent("dropbox_clip.mov");
    });
  });
});
