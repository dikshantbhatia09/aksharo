import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DropboxChooserButton } from "./dropbox-chooser";

describe("<DropboxChooserButton />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).Dropbox;
  });

  it("renders Dropbox button", () => {
    const onFileSelected = vi.fn();
    render(<DropboxChooserButton onFileSelected={onFileSelected} />);

    expect(screen.getByTestId("dropbox-chooser-button")).toBeInTheDocument();
    expect(screen.getByText("Dropbox")).toBeInTheDocument();
  });

  it("invokes Dropbox.choose with direct link and triggers callback", async () => {
    const user = userEvent.setup();
    const onFileSelected = vi.fn();

    (window as any).Dropbox = {
      isBrowserSupported: vi.fn().mockReturnValue(true),
      choose: vi.fn().mockImplementation((options) => {
        options.success([
          {
            id: "id:dropbox123",
            name: "podcast_ep12.wav",
            bytes: 52428800,
            link: "https://dl.dropboxusercontent.com/s/abcdef/podcast_ep12.wav",
          },
        ]);
      }),
    };

    render(
      <DropboxChooserButton
        onFileSelected={onFileSelected}
        appKey="mock-dropbox-app-key"
      />,
    );

    await user.click(screen.getByTestId("dropbox-chooser-button"));

    await waitFor(() => {
      expect((window as any).Dropbox.choose).toHaveBeenCalledWith(
        expect.objectContaining({
          linkType: "direct",
          multiselect: false,
        }),
      );
      expect(onFileSelected).toHaveBeenCalledWith({
        provider: "DROPBOX",
        fileId: "id:dropbox123",
        fileName: "podcast_ep12.wav",
        fileSizeBytes: 52428800,
        downloadUrl: "https://dl.dropboxusercontent.com/s/abcdef/podcast_ep12.wav",
      });
    });
  });
});

