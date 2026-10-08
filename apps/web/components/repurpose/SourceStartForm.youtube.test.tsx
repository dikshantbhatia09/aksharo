import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { EMPTY_START_FORM, SourceStartForm, type StartFormValue } from "./SourceStartForm";
import { renderWithProviders } from "@/test/harness";
import type { YouTubeProbeResponse } from "@montaj/repurpose-contracts";

const PROBE_RESPONSE: YouTubeProbeResponse = {
  videoId: "dQw4w9WgXcQ",
  title: "Complete Guide to Microservices",
  channelName: "Tech Channel",
  durationSec: 900,
  thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  isLiveStream: false,
  hasCaptions: true,
  nativeChapters: [
    { title: "Intro & Overview", startSec: 0, endSec: 120 },
    { title: "Service Discovery", startSec: 120, endSec: 450 },
    { title: "Circuit Breakers", startSec: 450, endSec: 900 },
  ],
};

function Harness({
  initialUrl = "",
  onValue,
}: {
  readonly initialUrl?: string;
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>({
    ...EMPTY_START_FORM,
    url: initialUrl,
  });

  React.useEffect(() => {
    onValue?.(value);
  }, [value, onValue]);

  return (
    <SourceStartForm
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
    />
  );
}

describe("<SourceStartForm /> YouTube preview and chapters integration", () => {
  it("probes YouTube URL, renders preview card with chapters, and clicking chapter sets Start at", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;

    renderWithProviders(
      <Harness
        initialUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        onValue={(val) => {
          latest = val;
        }}
      />,
      {
        routes: {
          "/media/probe-url": PROBE_RESPONSE,
        },
      },
    );

    // Wait for the probe query to resolve and preview card to render
    await waitFor(() => {
      expect(screen.getByTestId("youtube-preview-card")).toBeInTheDocument();
    });

    expect(screen.getByText("Complete Guide to Microservices")).toBeInTheDocument();
    expect(screen.getByText("Tech Channel")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.getByText(/3 creator chapters/i)).toBeInTheDocument();

    // Verify chapter chips are rendered
    const chapter1 = screen.getByTestId("chapter-chip-1");
    expect(chapter1).toHaveTextContent("Service Discovery");
    expect(chapter1).toHaveTextContent("2:00");

    // Click the second chapter chip (startSec: 120 -> 2:00)
    await user.click(chapter1);

    // Verify "Start at" input has been updated
    const startAtInput = screen.getByTestId("source-start-at");
    expect(startAtInput).toHaveValue("2:00");
    expect(latest.startAt).toBe("2:00");
  });
});

