import { act, render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { IndeterminateBar, ProcessingScreen, useRotatingTip } from "./processing-tips";

function Harness({
  tips,
  intervalMs,
}: {
  tips: readonly string[];
  intervalMs?: number;
}): React.JSX.Element {
  const tip = useRotatingTip(tips, intervalMs);
  return <p data-testid="tip">{tip}</p>;
}

describe("useRotatingTip", () => {
  it("starts on the first tip", () => {
    render(<Harness tips={["a", "b", "c"]} />);
    expect(screen.getByTestId("tip")).toHaveTextContent("a");
  });

  it("cycles to the next tip after the interval, and wraps around", () => {
    vi.useFakeTimers();
    render(<Harness tips={["a", "b"]} intervalMs={1_000} />);
    expect(screen.getByTestId("tip")).toHaveTextContent("a");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("tip")).toHaveTextContent("b");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("tip")).toHaveTextContent("a");
    vi.useRealTimers();
  });

  it("never rotates a single tip", () => {
    vi.useFakeTimers();
    render(<Harness tips={["only"]} intervalMs={100} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("tip")).toHaveTextContent("only");
    vi.useRealTimers();
  });
});

describe("IndeterminateBar", () => {
  it("is a progressbar with no claimed numeric value", () => {
    render(<IndeterminateBar label="Uploading your video" />);
    const bar = screen.getByRole("progressbar", { name: "Uploading your video" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });
});

describe("ProcessingScreen", () => {
  it("renders the headline, tip and an indeterminate bar with no progress prop", () => {
    render(
      <ProcessingScreen
        icon={<span />}
        headline="Analyzing your media"
        subtext="Checking things."
        tip="A tip."
      />,
    );
    expect(screen.getByTestId("processing-headline")).toHaveTextContent("Analyzing your media");
    expect(screen.getByTestId("processing-tip")).toHaveTextContent("A tip.");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("renders a real percentage bar when progress is given", () => {
    render(<ProcessingScreen icon={<span />} headline="Uploading" tip="A tip." progress={42} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });
});
