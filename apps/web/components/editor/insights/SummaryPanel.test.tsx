import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { InsightRow } from "@montaj/api-client";

import { SummaryPanel } from "./SummaryPanel";


const ROW: InsightRow = {
  id: "row1",
  kind: "summary",
  templateVersion: "summary@1",
  provider: "mock",
  region: "in",
  output: { short: "Short one.", medium: "Medium one.", long: "Long one." },
  usage: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("<SummaryPanel />", () => {
  it("defaults to the medium length", () => {
    render(<SummaryPanel row={ROW} />);
    expect(screen.getByTestId("summary-medium")).toHaveTextContent("Medium one.");
  });

  it("switching the length switches the visible text", async () => {
    const user = userEvent.setup();
    render(<SummaryPanel row={ROW} />);
    await user.click(screen.getByRole("tab", { name: "Short" }));
    expect(screen.getByTestId("summary-short")).toHaveTextContent("Short one.");
  });

  it("copies whichever length is currently active", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SummaryPanel row={ROW} />);
    await user.click(screen.getByRole("tab", { name: "Long" }));
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("Long one.");
  });
});
