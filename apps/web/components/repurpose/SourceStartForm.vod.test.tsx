import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { EMPTY_START_FORM, SourceStartForm, type StartFormValue } from "./SourceStartForm";
import { renderWithProviders } from "@/test/harness";
import type { VodProbeResponse } from "@montaj/repurpose-contracts";

const VOD_PROBE_RESPONSE: VodProbeResponse = {
  platform: "TWITCH",
  vodId: "2091234567",
  title: "10-HOUR SUBATHON CHAMPIONSHIP",
  channelName: "Shroud",
  durationSec: 36000, // 10 hours
  thumbnailUrl: "https://example.com/shroud-vod.jpg",
  isLive: false,
  chatVelocity: [
    { timestampSec: 0, mps: 2.0, topKeywords: ["GG"] },
    { timestampSec: 1800, mps: 34.2, topKeywords: ["W", "POG", "CLIP THAT"] },
    { timestampSec: 3600, mps: 3.1, topKeywords: [] },
  ],
  peaks: [
    {
      startSec: 1770,
      endSec: 1830,
      score: 98,
      topEmotes: ["POG", "W", "CLIP THAT"],
      reason: "Crazy 1v5 clutch ace",
    },
    {
      startSec: 7200,
      endSec: 7260,
      score: 85,
      topEmotes: ["LMAO"],
      reason: "Hilarious driving glitch",
    },
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

describe("<SourceStartForm /> VOD range selector integration", () => {
  it("probes Twitch VOD URL, renders VodRangeSelector with chat heatmap, and clicking peak sets Start at", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;

    renderWithProviders(
      <Harness
        initialUrl="https://www.twitch.tv/videos/2091234567"
        onValue={(val) => {
          latest = val;
        }}
      />,
      {
        routes: {
          "/media/probe-vod": VOD_PROBE_RESPONSE,
        },
      },
    );

    // Wait for the probe query to resolve and VOD range selector to render
    await waitFor(() => {
      expect(screen.getByTestId("vod-range-selector")).toBeInTheDocument();
    });

    expect(screen.getByText("TWITCH")).toBeInTheDocument();
    expect(screen.getByText("10-HOUR SUBATHON CHAMPIONSHIP")).toBeInTheDocument();
    expect(screen.getByText("Shroud")).toBeInTheDocument();
    expect(screen.getByText("10:00:00")).toBeInTheDocument();

    // Verify peak badge
    const peakBadge0 = screen.getByTestId("peak-badge-0");
    expect(peakBadge0).toBeInTheDocument();
    expect(peakBadge0).toHaveTextContent("29:30 - 30:30");
    expect(peakBadge0).toHaveTextContent("98 pts");

    // Click the first peak (startSec: 1770 -> 29:30)
    await user.click(peakBadge0);

    // Verify "Start at" input has been updated
    const startAtInput = screen.getByTestId("source-start-at");
    expect(startAtInput).toHaveValue("29:30");
    expect(latest.startAt).toBe("29:30");
  });
});

