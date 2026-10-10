import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@montaj/ui";

import { HashtagPicker } from "./hashtag-picker";

describe("HashtagPicker Component (Pillar 7 §03)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders 3-tier pyramid distribution summary and count badge", () => {
    render(
      <HashtagPicker
        initialTags={["#ai", "#technology", "#aiproductivity", "#ragpipeline"]}
        platform="youtube"
      />,
    );

    expect(screen.getByTestId("hashtag-picker")).toBeDefined();
    expect(screen.getByTestId("pyramid-tier-summary")).toBeDefined();
    expect(screen.getByText(/Tier 1: Broad/)).toBeDefined();
    expect(screen.getByText(/Tier 2: Community/)).toBeDefined();
    expect(screen.getByText(/Tier 3: Hyper-Niche/)).toBeDefined();
    expect(screen.getByTestId("hashtag-count-badge")).toHaveTextContent("4/5 tags");
  });

  it("renders interactive hashtag pills with tier indicator dots", () => {
    render(
      <HashtagPicker
        initialTags={["#ai", "#aiproductivity", "#ragpipeline"]}
        platform="youtube"
      />,
    );

    expect(screen.getByTestId("hashtag-pill-ai")).toBeDefined();
    expect(screen.getByTestId("hashtag-pill-aiproductivity")).toBeDefined();
    expect(screen.getByTestId("hashtag-pill-ragpipeline")).toBeDefined();
  });

  it("removes a hashtag when clicking its remove button", () => {
    const handleChange = vi.fn();
    render(
      <HashtagPicker
        initialTags={["#ai", "#aiproductivity", "#ragpipeline"]}
        platform="youtube"
        onChange={handleChange}
      />,
    );

    const removeBtn = screen.getByTestId("remove-tag-btn-ragpipeline");
    fireEvent.click(removeBtn);

    expect(screen.queryByTestId("hashtag-pill-ragpipeline")).toBeNull();
    expect(screen.getByTestId("hashtag-count-badge")).toHaveTextContent("2/5 tags");
    expect(handleChange).toHaveBeenCalledWith(["#ai", "#aiproductivity"]);
  });

  it("adds a custom hashtag via input and validates format", () => {
    const handleChange = vi.fn();
    render(
      <HashtagPicker
        initialTags={["#ai", "#aiproductivity"]}
        platform="youtube"
        onChange={handleChange}
      />,
    );

    const input = screen.getByTestId("custom-tag-input");
    fireEvent.change(input, { target: { value: "vectordatabases" } });

    const addBtn = screen.getByTestId("add-tag-btn");
    fireEvent.click(addBtn);

    expect(screen.getByTestId("hashtag-pill-vectordatabases")).toBeDefined();
    expect(handleChange).toHaveBeenCalledWith(["#ai", "#aiproductivity", "#vectordatabases"]);
  });

  it("copies entire hashtag bundle on 1-click and shows success toast", async () => {
    const successSpy = vi.spyOn(toast, "success");
    render(
      <HashtagPicker
        initialTags={["#ai", "#aiproductivity", "#ragpipeline"]}
        platform="youtube"
      />,
    );

    const copyBtn = screen.getByTestId("copy-hashtag-bundle-btn");
    fireEvent.click(copyBtn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("#ai #aiproductivity #ragpipeline");
    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledWith("Copied 3 hashtags to clipboard");
    });
  });

  it("auto-balances 3-tier pyramid bundle when clicking Auto-Balance button", () => {
    const handleChange = vi.fn();
    render(
      <HashtagPicker
        text="Building a vector search engine and RAG pipeline using local LLMs"
        title="Vector Search Guide"
        platform="instagram"
        onChange={handleChange}
      />,
    );

    const autobalanceBtn = screen.getByTestId("autobalance-btn");
    fireEvent.click(autobalanceBtn);

    const countBadge = screen.getByTestId("hashtag-count-badge");
    expect(countBadge).toBeDefined();
    expect(handleChange).toHaveBeenCalled();
  });
});
