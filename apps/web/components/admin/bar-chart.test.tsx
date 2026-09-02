import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BarChart } from "./bar-chart";

describe("BarChart", () => {
  it("renders one bar per datum, labelled by title", () => {
    render(
      <BarChart
        title="Acquisition by source"
        data={[
          { label: "referral", value: 40 },
          { label: "organic", value: 60 },
        ]}
      />,
    );

    expect(screen.getByText("Acquisition by source")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Acquisition by source" })).toBeInTheDocument();
  });

  it("shows a caption when given", () => {
    render(<BarChart title="Streak cohorts" data={[]} caption="Experiment vs holdout" />);
    expect(screen.getByText("Experiment vs holdout")).toBeInTheDocument();
  });

  it("renders a fallback message and no chart when there is no data", () => {
    render(<BarChart title="Empty" data={[]} />);
    expect(screen.getByText("No data yet.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("truncates a long label under the bar", () => {
    render(<BarChart title="Long labels" data={[{ label: "a-very-long-source-name", value: 1 }]} />);
    expect(screen.getByText("a-very-lo…")).toBeInTheDocument();
  });
});
