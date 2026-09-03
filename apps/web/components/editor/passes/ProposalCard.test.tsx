import { fireEvent, render, screen } from "@testing-library/react";
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
    render(
      <ProposalCard item={item()} onDecide={vi.fn()} onUndo={vi.fn()} onPreview={onPreview} />,
    );
    await user.click(screen.getByText("Preview before"));
    expect(onPreview).toHaveBeenCalledWith("before");
    await user.click(screen.getByText("Preview after"));
    expect(onPreview).toHaveBeenCalledWith("after");
  });

  it("shows a text preview and the motion preset for a title item (D06)", () => {
    const titleItem = item({
      kind: "title",
      payload: {
        text: "10x growth",
        styleRef: "system:textfx-default",
        position: { x: 0.5, y: 0.12, anchor: "top-center" },
        animIn: "count-up",
        animOut: "count-up",
        intent: "stat",
        motionPreset: "count-up",
      },
    });
    render(<ProposalCard item={titleItem} onDecide={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByTestId("proposal-card-title-text")).toHaveTextContent("10x growth");
    expect(screen.getByTestId("proposal-card-title-preset")).toHaveTextContent("count-up");
  });

  it("renders no title-text block for a non-title item", () => {
    render(<ProposalCard item={item()} onDecide={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.queryByTestId("proposal-card-title-text")).not.toBeInTheDocument();
  });

  function sfxItem(overrides: { readonly gainDb?: number } = {}): PassItem {
    return item({
      kind: "sfx",
      payload: {
        assetId: "01JASSET0000000000000000A1",
        packId: "fixture-pack",
        startMs: 1000,
        durationMs: 600,
        gainDb: overrides.gainDb ?? -6,
        fadeInMs: 0,
        fadeOutMs: 0,
        duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
        licenceSnapshot: { provider: "owned" },
        cueReason: "energy-peak → impact",
      },
    } as Partial<PassItem>);
  }

  it("shows a gain slider for an sfx item, seeded from payload.gainDb (D04c)", () => {
    render(<ProposalCard item={sfxItem()} onDecide={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.getByTestId("proposal-card-sfx")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-card-sfx-gain-value")).toHaveTextContent("-6.0 dB");
  });

  it("calls onGainDbPreview as the sfx gain slider moves, without waiting for a durable op", async () => {
    const onGainDbPreview = vi.fn();
    render(
      <ProposalCard
        item={sfxItem()}
        onDecide={vi.fn()}
        onUndo={vi.fn()}
        onGainDbPreview={onGainDbPreview}
      />,
    );
    const slider = screen.getByTestId("proposal-card-sfx-gain");
    fireEvent.change(slider, { target: { value: "-3" } });
    expect(onGainDbPreview).toHaveBeenCalledWith(-3);
    expect(screen.getByTestId("proposal-card-sfx-gain-value")).toHaveTextContent("-3.0 dB");
  });

  it("renders an <audio> preview only when sfxPreviewUrl is supplied", () => {
    const { rerender } = render(
      <ProposalCard item={sfxItem()} onDecide={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(screen.queryByTestId("proposal-card-sfx-preview")).not.toBeInTheDocument();

    rerender(
      <ProposalCard
        item={sfxItem()}
        onDecide={vi.fn()}
        onUndo={vi.fn()}
        sfxPreviewUrl="https://cdn.example/packs/fixture-pack/asset.wav?sig=abc"
      />,
    );
    expect(screen.getByTestId("proposal-card-sfx-preview")).toHaveAttribute(
      "src",
      "https://cdn.example/packs/fixture-pack/asset.wav?sig=abc",
    );
  });

  it("renders no sfx block for a non-sfx item", () => {
    render(<ProposalCard item={item()} onDecide={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.queryByTestId("proposal-card-sfx")).not.toBeInTheDocument();
  });
});
