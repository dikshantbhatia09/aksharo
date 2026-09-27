import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClientModule from "@montaj/api-client";

import { SourceUploadOffer, offersUpload } from "./SourceUploadOffer";

const mutate = vi.fn();
const addFilesToProjects = vi.fn();

vi.mock("@montaj/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  useRepurposeUpload: () => ({ mutate, isPending: false }),
}));

vi.mock("@/lib/upload/use-upload-queue", () => ({
  useUploadQueue: () => ({ addFilesToProjects }),
}));

function run(
  overrides: Partial<ApiClientModule.RepurposeRunView> = {},
): ApiClientModule.RepurposeRunView {
  return {
    id: "01M3RUN0000000000000000000",
    workspaceId: "01M3WS00000000000000000000",
    sourceProjectId: "01M3PR0JECT000000000000000",
    sourceKind: "youtube_url",
    sourceDisplay: "youtube.com · dQw4w9WgXcQ",
    mode: "ai",
    status: "acquiring",
    currentStage: "getting_video",
    progress: 5,
    stages: [],
    message: "Getting your video",
    failureCode: null,
    canCancel: true,
    canRetry: false,
    candidateCount: 0,
    clipCount: 0,
    variantCount: 0,
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    waitingFor: null,
    ...overrides,
  } as ApiClientModule.RepurposeRunView;
}

beforeEach(() => {
  mutate.mockReset();
  addFilesToProjects.mockReset();
});

describe("offersUpload", () => {
  it("offers the file while the run waits for YouTube", () => {
    expect(
      offersUpload(run({ waitingFor: { reason: "source_busy", until: "2026-09-27T10:15:00Z" } })),
    ).toBe(true);
  });

  it("offers it under a download a copy of the file gets round, and nowhere else", () => {
    const failed = (failureCode: string) =>
      run({ status: "failed", failureCode, currentStage: "getting_video" });
    expect(offersUpload(failed("repurpose/source_blocked"))).toBe(true);
    expect(offersUpload(failed("repurpose/source_private"))).toBe(true);
    // A video that is too long is too long as a file as well.
    expect(offersUpload(failed("repurpose/source_too_long"))).toBe(false);
    expect(offersUpload(run())).toBe(false);
    expect(offersUpload(run({ sourceKind: "upload", waitingFor: null }))).toBe(false);
    expect(
      offersUpload(
        run({
          status: "failed",
          failureCode: "repurpose/transcription_failed",
          currentStage: "finding_clips",
        }),
      ),
    ).toBe(false);
  });
});

describe("SourceUploadOffer", () => {
  it("says the run goes on by itself, and when", () => {
    render(
      <SourceUploadOffer
        run={run({ waitingFor: { reason: "source_busy", until: "2026-09-27T10:15:00Z" } })}
      />,
    );
    expect(screen.getByTestId("source-waiting").textContent).toMatch(
      /will try again by itself at .+, so you can leave this page/,
    );
  });

  it("turns the run into an upload, then sends the file into its source project", () => {
    render(
      <SourceUploadOffer
        run={run({ status: "failed", failureCode: "repurpose/source_blocked" })}
      />,
    );
    const file = new File(["x"], "talk.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("source-upload-input"), { target: { files: [file] } });

    expect(mutate).toHaveBeenCalledWith("01M3RUN0000000000000000000", expect.any(Object));
    const handlers = mutate.mock.calls[0]?.[1] as {
      onSuccess: (converted: ApiClientModule.RepurposeRunView) => void;
    };
    handlers.onSuccess(run({ sourceKind: "upload" }));
    expect(addFilesToProjects).toHaveBeenCalledWith(
      [{ file, projectId: "01M3PR0JECT000000000000000" }],
      { aspect: "9:16" },
    );
  });

  it("renders nothing where a file would not help", () => {
    const { container } = render(<SourceUploadOffer run={run()} />);
    expect(container.firstChild).toBeNull();
  });
});
