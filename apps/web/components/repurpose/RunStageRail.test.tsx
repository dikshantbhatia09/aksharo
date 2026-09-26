import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RepurposeStageView } from "@montaj/api-client";

import { RunStageRail } from "./RunStageRail";

/**
 * The rail says what the run is DOING, not what the stage projection implies
 * (clips hardening, 2026-09-26). The API marks the current stage `running` for
 * a run waiting on the person and for one they stopped, and marks a failed
 * stage `failed` — which the rail treated as "not reached yet".
 */
function rail(states: readonly RepurposeStageView["state"][]): RepurposeStageView[] {
  const keys = ["getting_video", "finding_clips", "styles_formats", "review", "publish"] as const;
  return keys.map((stage, index) => ({ stage, state: states.at(index) ?? "waiting", label: stage }));
}

describe("<RunStageRail /> tells the truth about the run", () => {
  it("opens the failed step, instead of saying it opens once earlier steps are done", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onBlocked = vi.fn();
    render(
      <RunStageRail
        stages={rail(["failed"])}
        activity="failed"
        onOpenStage={onOpen}
        onBlockedStage={onBlocked}
      />,
    );
    await user.click(screen.getByTestId("stage-node-getting_video").querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith("getting_video");
    expect(onBlocked).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Step 1 of 5: Add video\. Needs attention\./ }),
    ).toBeInTheDocument();
  });

  it("does not call a stopped run's last step 'In progress'", () => {
    render(<RunStageRail stages={rail(["complete", "running"])} activity="stopped" />);
    const node = screen.getByTestId("stage-node-finding_clips");
    expect(node).toHaveAttribute("data-stopped", "true");
    expect(screen.getByRole("button", { name: /Find clips\. Stopped\./ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /In progress/ })).toBeNull();
    expect(node.querySelector("button")).not.toHaveAttribute("aria-current");
  });

  it("says it is the person's turn when the run waits on them", () => {
    render(<RunStageRail stages={rail(["complete", "running"])} activity="needs_you" />);
    expect(screen.getByRole("button", { name: /Find clips\. Your turn\./ })).toBeInTheDocument();
  });

  it("still says 'In progress' while the server is working", () => {
    render(<RunStageRail stages={rail(["complete", "running"])} activity="working" />);
    expect(screen.getByRole("button", { name: /Find clips\. In progress\./ })).toBeInTheDocument();
  });
});
