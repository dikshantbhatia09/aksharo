import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { NeedsTranscription } from "./needs-transcription";

import { renderWithProviders } from "@/test/harness";

const PROJECT = {
  id: "01PROJECT",
  title: "Villa walkthrough",
  status: "active",
  sourceLanguage: "hi-Latn",
  scripts: [],
};

describe("<NeedsTranscription />", () => {
  // The editor used to dead-end here with a red sentence and no way forward.
  it("offers the work instead of an error", () => {
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: { "/projects/01PROJECT": PROJECT },
    });
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "has not been transcribed yet",
    );
    expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
  });

  it("starts transcription in the project's own language", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        "/projects/01PROJECT/transcribe": { jobId: "01JOB", transcriptId: "01T" },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
    });
    await user.click(screen.getByTestId("editor-start-transcription"));

    await waitFor(() => {
      expect(screen.getByTestId("editor-start-transcription")).toBeDisabled();
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/transcribe"));
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ languages: ["hi-Latn"] });
  });
});
