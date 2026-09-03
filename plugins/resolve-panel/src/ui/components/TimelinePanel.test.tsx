import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TimelinePanel } from "./TimelinePanel.js";

describe("TimelinePanel", () => {
  it("shows the no-timeline state", () => {
    render(
      <TimelinePanel
        timeline={undefined}
        stage="idle"
        stageMessage={undefined}
        onTranscribe={() => {}}
      />,
    );
    expect(screen.getByTestId("no-timeline")).toBeInTheDocument();
  });

  it("shows the timeline name/fps and calls onTranscribe", async () => {
    const onTranscribe = vi.fn();
    render(
      <TimelinePanel
        timeline={{ name: "Timeline 1", fps: 25 }}
        stage="idle"
        stageMessage={undefined}
        onTranscribe={onTranscribe}
      />,
    );
    expect(screen.getByTestId("timeline-name").textContent).toBe("Timeline 1 (25 fps)");
    await userEvent.click(screen.getByTestId("transcribe-button"));
    expect(onTranscribe).toHaveBeenCalledOnce();
  });

  it("disables the button and shows the stage while busy", () => {
    render(
      <TimelinePanel
        timeline={{ name: "Timeline 1", fps: 25 }}
        stage="uploading"
        stageMessage={undefined}
        onTranscribe={() => {}}
      />,
    );
    expect(screen.getByTestId("transcribe-button")).toBeDisabled();
    expect(screen.getByTestId("transcribe-stage").textContent).toBe("Uploading…");
  });

  it("shows an error message", () => {
    render(
      <TimelinePanel
        timeline={{ name: "Timeline 1", fps: 25 }}
        stage="error"
        stageMessage="network down"
        onTranscribe={() => {}}
      />,
    );
    expect(screen.getByTestId("transcribe-stage").textContent).toMatch(/network down/);
  });
});
