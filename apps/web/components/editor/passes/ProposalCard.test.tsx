import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PassItem } from "@montaj/edg";

import { ProposalCard } from "./ProposalCard";

function item(overrides: Partial<PassItem> = {}): PassItem {
  return {
    itemId: "i1",
    passId: "p1",
    kind: "cut",
    startMs: 1000,
    endMs: 2500,
    payload: {},
    state: "proposed",
    confidence: 0.87,
    reason: "1.5s of silence",
    ...overrides,
  } as PassItem;
}

describe("<ProposalCard />", () => {
  it("shows the kind, range, confidence and reason", () => {
    render(<ProposalCard item={item()} onDecide={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByText("Cut")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-card-confidence")).toHaveTextContent("87%");
    expect(screen.getByTestId("proposal-card-reason")).toHaveTextContent("1.5s of silence");
  });

  it("calls onDecide('accepted') / onDecide('rejected') from the two buttons", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<ProposalCard item={item()} onDecide={onDecide} onUndo={vi.fn()} />);
    await user.click(screen.getByTestId("proposal-card-accept"));
    expect(onDecide).toHaveBeenCalledWith("accepted");
    await user.click(screen.getByTestId("proposal-card-reject"));
    expect(onDecide).toHaveBeenCalledWith("rejected");
  });

  it("shows Undo instead of Accept/Reject once decided, and calls onUndo", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    render(<ProposalCard item={item({ state: "accepted" })} onDecide={vi.fn()} onUndo={onUndo} />);
    expect(screen.queryByTestId("proposal-card-accept")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("proposal-card-undo"));
    expect(onUndo).toHaveBeenCalled();
  });

  it("invokes onPreview with before/after when the preview buttons are provided", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(<ProposalCard item={item()} onDecide={vi.fn()} onUndo={vi.fn()} onPreview={onPreview} />);
    await user.click(screen.getByText("Preview before"));
    expect(onPreview).toHaveBeenCalledWith("before");
    await user.click(screen.getByText("Preview after"));
    expect(onPreview).toHaveBeenCalledWith("after");
  });
});
