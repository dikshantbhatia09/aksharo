import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { InsightRow } from "@montaj/api-client";

import { ChaptersPanel } from "./ChaptersPanel";

function row(chapters: { startMs: number; title: string }[]): InsightRow {
  return {
    id: "row1",
    kind: "chapters",
    templateVersion: "chapters@1",
    provider: "mock",
    region: "in",
    output: { chapters },
    usage: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("<ChaptersPanel />", () => {
  it("shows an empty state with no chapters", () => {
    render(<ChaptersPanel row={row([])} />);
    expect(screen.getByTestId("chapters-empty")).toBeInTheDocument();
  });

  it("lists every chapter with its timestamp", () => {
    render(
      <ChaptersPanel
        row={row([
          { startMs: 0, title: "Intro" },
          { startMs: 65_000, title: "Main topic" },
        ])}
      />,
    );
    expect(screen.getByText("Intro")).toBeInTheDocument();
    expect(screen.getByText("Main topic")).toBeInTheDocument();
    expect(screen.getByText("1:05")).toBeInTheDocument();
  });

  it("jump-to calls onSeek with the chapter's startMs", async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    render(<ChaptersPanel row={row([{ startMs: 65_000, title: "Main topic" }])} onSeek={onSeek} />);
    await user.click(screen.getByTestId("chapter-jump-65000"));
    expect(onSeek).toHaveBeenCalledWith(65_000);
  });

  it("copies the whole list as a YouTube description", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <ChaptersPanel
        row={row([
          { startMs: 4_000, title: "Intro" },
          { startMs: 65_000, title: "Main topic" },
        ])}
      />,
    );
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("0:00 Intro\n1:05 Main topic");
  });
});
