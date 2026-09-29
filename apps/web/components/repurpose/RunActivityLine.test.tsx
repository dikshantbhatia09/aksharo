import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunActivityLine, activityEta, activitySentence } from "./RunActivityLine";

describe("the step line", () => {
  it("reads as one line: what, how much, how long", () => {
    expect(
      activitySentence({
        step: "downloading",
        label: "Downloading your video",
        percent: 62,
        detail: "3.1 of 5.0 GB",
        etaSeconds: 130,
      }),
    ).toBe("Downloading your video · 3.1 of 5.0 GB · about 2 min left");
    expect(
      activitySentence({
        step: "queued",
        label: "Waiting for a free spot",
        detail: "2 ahead of you",
        queuePosition: 2,
      }),
    ).toBe("Waiting for a free spot · 2 ahead of you");
  });

  it("never makes up a time the API did not send", () => {
    expect(activityEta({})).toBeUndefined();
    expect(
      activitySentence({ step: "cutting", label: "Cutting your clips", detail: "clip 3 of 10" }),
    ).toBe("Cutting your clips · clip 3 of 10");
    expect(activityEta({ etaSeconds: 4 })).toBe("almost done");
  });

  it("draws this step's own bar only when the step can be measured", () => {
    const { rerender } = render(
      <RunActivityLine
        activity={{ step: "captioning", label: "Adding captions to your clips", percent: 27 }}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "27");
    expect(bar).toHaveAccessibleName("Adding captions to your clips: 27%");
    expect(screen.getByTestId("run-activity")).toHaveAttribute("data-step", "captioning");

    rerender(<RunActivityLine activity={{ step: "waiting", label: "YouTube asked us to wait" }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
