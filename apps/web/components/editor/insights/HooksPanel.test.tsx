import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { InsightRow } from "@montaj/api-client";

import { HooksPanel } from "./HooksPanel";


function variant(prefix: string): {
  hooks: string[];
  titles: string[];
  hashtags: string[];
} {
  return {
    hooks: Array.from({ length: 5 }, (_, i) => `${prefix} hook ${String(i)}`),
    titles: Array.from({ length: 5 }, (_, i) => `${prefix} title ${String(i)}`),
    hashtags: Array.from({ length: 10 }, (_, i) => `#${prefix}${String(i)}`),
  };
}

const ROW: InsightRow = {
  id: "row1",
  kind: "hooks",
  templateVersion: "hooks@1",
  provider: "mock",
  region: "in",
  output: { youtube: variant("yt"), instagram: variant("ig"), tiktok: variant("tt") },
  usage: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("<HooksPanel />", () => {
  it("defaults to the YouTube tab", () => {
    render(<HooksPanel row={ROW} />);
    expect(screen.getByText("yt hook 0")).toBeInTheDocument();
  });

  it("switching platform switches hooks/titles/hashtags", async () => {
    const user = userEvent.setup();
    render(<HooksPanel row={ROW} />);
    await user.click(screen.getByRole("tab", { name: "Instagram" }));
    expect(screen.getByText("ig hook 0")).toBeInTheDocument();
    expect(screen.getByText("#ig0")).toBeInTheDocument();
  });

  it("copies the hashtags for the active platform", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<HooksPanel row={ROW} />);
    const hashtagSection = screen.getByTestId("hooks-hashtags-youtube").closest("div")?.parentElement;
    const copyButton = hashtagSection?.querySelector("button[aria-label='Copy hashtags']");
    expect(copyButton).not.toBeNull();
    await user.click(copyButton as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(variant("yt").hashtags.join(" "));
  });
});
