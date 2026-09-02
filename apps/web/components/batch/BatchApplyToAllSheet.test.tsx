import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BatchApplyToAllSheet, type BatchConfirmed } from "./BatchApplyToAllSheet";

import { renderWithProviders } from "@/test/harness";


// Duration reading goes through a real <video>'s `loadedmetadata` event,
// which jsdom does not implement (no `URL.createObjectURL`, no media
// decoding) -- that is `lib/batch/duration.ts`'s own concern, not this
// component's; mocked here so the sheet's own logic (quote display, confirm,
// pairing files to the projects the API returns) is what the test checks.
vi.mock("@/lib/batch/duration", () => ({
  readFileDurationMs: vi.fn(async () => 60_000),
}));

function fakeFile(name: string): File {
  return new File([new Uint8Array(5)], name, { type: "video/mp4" });
}

describe("BatchApplyToAllSheet", () => {
  it("creates a batch and pairs each file with the project the API returned", async () => {
    const files = [fakeFile("a.mp4"), fakeFile("b.mp4")];
    let confirmed: BatchConfirmed | undefined;

    renderWithProviders(
      <BatchApplyToAllSheet
        files={files}
        quickPick={{ language: "hi-Latn", aspect: "9:16" }}
        onCancel={() => undefined}
        onConfirmed={(result) => {
          confirmed = result;
        }}
      />,
      {
        routes: {
          "/batch": {
            id: "01JBATCH00000000000000000",
            workspaceId: "01JWORKSPACE000000000000A",
            settings: {},
            creditsQuoted: "2",
            createdAt: "2026-09-02T00:00:00.000Z",
            projects: [
              {
                projectId: "01JPROJECTA0000000000000A",
                title: "a",
                status: "draft",
                latestJobStatus: null,
                latestJobType: null,
                latestJobError: null,
              },
              {
                projectId: "01JPROJECTB0000000000000A",
                title: "b",
                status: "draft",
                latestJobStatus: null,
                latestJobType: null,
                latestJobError: null,
              },
            ],
          },
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId("batch-confirm")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId("batch-confirm"));

    await waitFor(() => {
      expect(confirmed?.batchId).toBe("01JBATCH00000000000000000");
    });
    expect(confirmed?.pairs).toEqual([
      { file: files[0], projectId: "01JPROJECTA0000000000000A" },
      { file: files[1], projectId: "01JPROJECTB0000000000000A" },
    ]);
  });
});
