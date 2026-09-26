import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StageErrorCard } from "./StagePanel";

/**
 * The failed run's card offers the failure's OWN next step (clips hardening,
 * 2026-09-26). It used to offer "Choose another video" for every download
 * failure — including YouTube turning the server away for a few minutes, where
 * the same link is exactly right — and threw the link away while doing it.
 */
function renderCard(
  code: string,
  props: Partial<React.ComponentProps<typeof StageErrorCard>> = {},
) {
  const handlers = {
    onRetry: vi.fn(),
    onChooseAnother: vi.fn(),
    onCheckLink: vi.fn(),
    onAddMoment: vi.fn(),
  };
  render(<StageErrorCard code={code} supportCode="01JS" {...handlers} {...props} />);
  return handlers;
}

/** Every button on the card that is its primary (the rani fill). */
function primaries(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.className.split(/\s+/).includes("bg-accent"));
}

describe("<StageErrorCard /> recommends the failure's own action", () => {
  it("retries the same link when YouTube is only refusing us for now", async () => {
    const user = userEvent.setup();
    const handlers = renderCard("repurpose/source_blocked");
    expect(primaries()).toEqual([screen.getByTestId("stage-error-retry")]);
    await user.click(screen.getByTestId("stage-error-retry"));
    expect(handlers.onRetry).toHaveBeenCalledOnce();
    // The quiet way out is still there, but it is not the recommendation.
    expect(screen.getByTestId("stage-error-choose-another")).toBeInTheDocument();
  });

  it("makes another video the one primary when this one can never work", () => {
    for (const code of ["repurpose/source_too_large", "repurpose/source_too_long"]) {
      const { unmount } = render(
        <StageErrorCard
          code={code}
          supportCode="01JS"
          onRetry={() => undefined}
          onChooseAnother={() => undefined}
        />,
      );
      expect(screen.queryByTestId("stage-error-retry")).toBeNull();
      expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
      expect(screen.getByRole("alert")).toHaveTextContent(
        /longer than your plan allows|bigger than your plan allows/,
      );
      unmount();
    }
  });

  it("opens the same link to fix when it is a playlist", async () => {
    const user = userEvent.setup();
    const handlers = renderCard("repurpose/source_playlist");
    expect(primaries()).toEqual([screen.getByTestId("stage-error-check-link")]);
    await user.click(screen.getByTestId("stage-error-check-link"));
    expect(handlers.onCheckLink).toHaveBeenCalledOnce();
  });

  it("offers picking the times when no strong moment was found", async () => {
    const user = userEvent.setup();
    const handlers = renderCard("repurpose/highlights_no_candidates");
    await user.click(screen.getByTestId("stage-error-add-moment"));
    expect(handlers.onAddMoment).toHaveBeenCalledOnce();
  });

  it("falls back to another video when the run says it cannot be retried", () => {
    render(
      <StageErrorCard
        code="repurpose/source_blocked"
        supportCode="01JS"
        onChooseAnother={() => undefined}
      />,
    );
    expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
  });

  it("shows progress while the retry is in flight", () => {
    renderCard("repurpose/source_unavailable", { retrying: true });
    expect(screen.getByTestId("stage-error-retry")).toBeDisabled();
    expect(screen.getByTestId("stage-error-retry")).toHaveTextContent("Trying again…");
  });

  it("links to the run that already has this video when the retry was refused for it", () => {
    renderCard("repurpose/source_unavailable", {
      retryError: "You are already working on this video in another run.",
      existingRunId: "01JSNEWER",
    });
    expect(screen.getByTestId("stage-error-retry-error")).toHaveTextContent(/already working/);
    expect(screen.getByTestId("stage-error-existing-run")).toHaveAttribute(
      "href",
      "/repurpose/01JSNEWER",
    );
  });

  // It said "Add credits from Billing, then try again" with "Try again" as its
  // one action — which only fails the same way, and credits cannot be bought
  // while checkout is off. The balance is what can be looked at.
  it("points at the credit balance when out of credits, keeping Try again for after", async () => {
    const user = userEvent.setup();
    const handlers = renderCard("repurpose/no_credits");
    const credits = screen.getByTestId("stage-error-credits");
    expect(credits).toHaveAttribute("href", "/billing");
    expect(credits.className.split(/\s+/)).toContain("bg-accent");
    // Still there, but not the recommendation: nothing is primary but the link.
    expect(primaries()).toEqual([]);
    await user.click(screen.getByTestId("stage-error-retry"));
    expect(handlers.onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Add credits|Billing/);
  });

  it("names a code older runs still carry instead of 'Something went wrong'", () => {
    renderCard("repurpose/analysis_failed");
    expect(screen.getByRole("alert")).toHaveTextContent("We could not finish finding moments");
  });
});
