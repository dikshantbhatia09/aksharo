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

  // The API now says `canRetry: false` when the retry could only be refused —
  // a run whose source was deleted carries `source_unavailable`, whose copy
  // said "It may work if you try again" over a card with no such button.
  it("leads with the way out, and promises no retry, when the run cannot be retried", () => {
    render(
      <StageErrorCard
        code="repurpose/source_unavailable"
        supportCode="01JS"
        onChooseAnother={() => undefined}
        onCheckLink={() => undefined}
      />,
    );
    expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
    expect(screen.getByTestId("stage-error-choose-another")).toHaveTextContent(
      "Choose another video",
    );
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "Everything you had before is still here.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/try again/i);
  });

  it("keeps the retry's own promise beside a retry the run offers", () => {
    renderCard("repurpose/source_unavailable");
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "Everything you had before is still here. It may work if you try again.",
    );
  });

  it("starts the same video afresh when its transcript has no timings", async () => {
    const user = userEvent.setup();
    const onStartAgain = vi.fn();
    const handlers = renderCard("repurpose/transcript_untimed", { onStartAgain });
    expect(primaries()).toEqual([screen.getByTestId("stage-error-start-again")]);
    expect(screen.getByTestId("stage-error-start-again")).toHaveTextContent(
      "Start again with this video",
    );
    // What starting again costs, said beside the button that does it.
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "makes a fresh transcript, which uses credits like any new video.",
    );
    // Retrying the run would only find the same untimed transcript again.
    expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    await user.click(screen.getByTestId("stage-error-start-again"));
    expect(onStartAgain).toHaveBeenCalledOnce();
    expect(handlers.onCheckLink).not.toHaveBeenCalled();
  });

  it("offers another video for an untimed transcript with no link to start again from", () => {
    render(
      <StageErrorCard
        code="repurpose/transcript_untimed"
        supportCode="01JS"
        onChooseAnother={() => undefined}
      />,
    );
    expect(screen.queryByTestId("stage-error-start-again")).toBeNull();
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
    // An upload run has no "Start again", so the card does not describe one.
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "without timings we cannot tell where a moment starts or ends.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/start(ing)? again|fresh transcript/i);
  });

  // Not "Upload it again": a file already in one of the person's projects is
  // matched to that copy and never arrives, so the same file into a new run
  // would wait a day and fail the same way.
  it("offers another video when an upload never arrived, and says why the same file may not work", () => {
    renderCard("repurpose/upload_missing");
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
    expect(screen.getByTestId("stage-error-choose-another")).toHaveTextContent(
      "Choose another video",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("We never received your video");
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      /already in one of your projects/,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/upload it again/i);
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
