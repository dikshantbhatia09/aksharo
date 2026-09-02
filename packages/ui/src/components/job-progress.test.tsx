import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatEta, JobProgress } from "./job-progress";

describe("formatEta", () => {
  it("rounds to ten seconds under a minute and a half", () => {
    expect(formatEta(44_000)).toBe("about 40 s left");
  });

  it("rounds to whole minutes above that", () => {
    expect(formatEta(150_000)).toBe("about 3 min left");
  });

  it("stops promising a number at the end", () => {
    expect(formatEta(3_000)).toBe("almost done");
  });

  it("is undefined for a missing or nonsense value", () => {
    expect(formatEta(undefined)).toBeUndefined();
    expect(formatEta(-1)).toBeUndefined();
    expect(formatEta(Number.NaN)).toBeUndefined();
  });
});

describe("<JobProgress />", () => {
  it("marks the current stage for assistive technology", () => {
    render(<JobProgress stage="transcribing" progress={40} etaMs={90_000} />);
    const active = screen.getByText("Transcribing");
    expect(active).toHaveAttribute("aria-current", "step");
    expect(active).toHaveAttribute("data-state", "active");
    expect(screen.getByText("Uploading")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("Aligning")).toHaveAttribute("data-state", "pending");
  });

  it("shows the ETA", () => {
    render(<JobProgress stage="aligning" etaMs={30_000} />);
    expect(screen.getByTestId("job-progress-eta")).toHaveTextContent("about 30 s left");
  });

  it("marks every stage done once the job is ready and drops the bar", () => {
    render(<JobProgress stage="ready" progress={100} />);
    expect(screen.getByText("Uploading")).toHaveAttribute("data-state", "done");
    expect(screen.getByText("Ready")).toHaveAttribute("data-state", "done");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says what went wrong and offers a retry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <JobProgress
        stage="transcribing"
        error="We could not read the audio track. Try re-uploading."
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("could not read the audio track");
    expect(screen.getByText("Transcribing")).toHaveAttribute("data-state", "failed");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
