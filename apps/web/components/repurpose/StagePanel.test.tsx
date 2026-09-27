import { cleanup, render, screen } from "@testing-library/react";
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

/**
 * A too-long video is not a dead end (plan limits, 2026-09-27): a plan limits
 * the minutes a run processes, so the card offers part of it — by a retry the
 * server windows, or from a start the person picks — and states the numbers
 * the run carried.
 *
 * The retry fetches the part the RUN asked for (`windowRequestOfRun` in the
 * API): a picked start stays that start, and the automatic choice is the
 * most-replayed part only when YouTube marks one. So its label names a length,
 * or the picked start, and never promises "the most-replayed" part.
 */
describe("<StageErrorCard /> for a video longer than the plan processes", () => {
  const MIN = 60_000;
  const LENGTH = 34 * MIN + 37_000; // 34:37
  // What the probe writes when a fetched file overran its window.
  const PROBE_FACTS = { durationMs: LENGTH, maxDurationMs: 20 * MIN, windowMs: 20 * MIN };

  function renderTooLong(props: Partial<React.ComponentProps<typeof StageErrorCard>> = {}) {
    const handlers = { onUseWindow: vi.fn(), onPickStart: vi.fn(), onChooseAnother: vi.fn() };
    render(
      <StageErrorCard
        code="repurpose/source_too_long"
        supportCode="01JS"
        detail={PROBE_FACTS}
        {...handlers}
        {...props}
      />,
    );
    return handlers;
  }

  it("states the numbers, and offers part of it as its one primary", async () => {
    const user = userEvent.setup();
    const handlers = renderTooLong();
    expect(screen.getByTestId("stage-error-title")).toHaveTextContent(
      "This video is 34:37. Your plan processes 20:00 per video.",
    );
    const useWindow = screen.getByTestId("stage-error-use-window");
    expect(useWindow).toHaveTextContent("Process 20 minutes of it");
    expect(useWindow).not.toHaveTextContent(/most-replayed/);
    expect(primaries()).toEqual([useWindow]);
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "We can find clips in part of it instead.",
    );
    // What fits instead is for a card that offers no part.
    expect(screen.getByTestId("stage-error-reassurance")).not.toHaveTextContent(/shorter video/);

    await user.click(useWindow);
    expect(handlers.onUseWindow).toHaveBeenCalledOnce();
    await user.click(screen.getByTestId("stage-error-pick-start"));
    expect(handlers.onPickStart).toHaveBeenCalledOnce();
    // Another video is still there, quietly.
    expect(screen.getByTestId("stage-error-choose-another")).toBeInTheDocument();
  });

  it("says which part the automatic choice takes, only when the run had no start of its own", () => {
    renderTooLong({ retryWindow: { kind: "auto" } });
    expect(screen.getByTestId("stage-error-use-window")).toHaveTextContent(
      "Process 20 minutes of it",
    );
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "We take the most-replayed part when YouTube marks one, otherwise the start.",
    );
  });

  it("says a picked start is fetched from that start again", () => {
    renderTooLong({ retryWindow: { kind: "range", startMs: 12 * MIN + 10_000 } });
    const useWindow = screen.getByTestId("stage-error-use-window");
    expect(useWindow).toHaveTextContent("Process 20 minutes from 12:10");
    expect(screen.getByTestId("stage-error-reassurance")).not.toHaveTextContent(/most-replayed/);
    // Their own start again is the recommendation; another start is beside it.
    expect(primaries()).toEqual([useWindow]);
    expect(screen.getByTestId("stage-error-pick-start")).toBeInTheDocument();
  });

  it("makes picking a start the primary when the run cannot be retried", () => {
    renderTooLong({ onUseWindow: undefined });
    expect(screen.queryByTestId("stage-error-use-window")).toBeNull();
    expect(primaries()).toEqual([screen.getByTestId("stage-error-pick-start")]);
  });

  it("offers part of it, with no length, when the run carried no numbers", () => {
    renderTooLong({ detail: null });
    expect(screen.getByTestId("stage-error-title")).toHaveTextContent(
      "This video is longer than your plan allows",
    );
    expect(screen.getByTestId("stage-error-use-window")).toHaveTextContent("Process part of it");
    cleanup();
    renderTooLong({ detail: null, retryWindow: { kind: "range", startMs: 5 * MIN } });
    expect(screen.getByTestId("stage-error-use-window")).toHaveTextContent(
      "Process part of it from 5:00",
    );
  });

  it("offers no part of a video over the ceiling, only another video", () => {
    // What the downloader writes when the video is over the 12-hour ceiling:
    // the ceiling as the limit, and no window.
    renderTooLong({ detail: { durationMs: 13 * 60 * MIN, maxDurationMs: 12 * 60 * MIN } });
    expect(screen.getByTestId("stage-error-title")).toHaveTextContent(
      "This video is 13:00:00. Your plan takes videos up to 12 hours long.",
    );
    expect(screen.queryByTestId("stage-error-use-window")).toBeNull();
    expect(screen.queryByTestId("stage-error-pick-start")).toBeNull();
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(/shorter video/);
  });

  it("falls back to another video for an upload, which has no part to process", () => {
    renderTooLong({ onUseWindow: undefined, onPickStart: undefined });
    expect(primaries()).toEqual([screen.getByTestId("stage-error-choose-another")]);
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "A shorter video, or a trimmed copy you upload, will fit.",
    );
    expect(screen.getByTestId("stage-error-reassurance")).not.toHaveTextContent(/part of it/);
  });
});

/**
 * A link's retry fetches the video again, and is refused up front when the
 * balance does not pay for a minute of it. Trying again then fails the same
 * way until the balance changes, so the balance is offered beside the refusal.
 */
describe("<StageErrorCard /> when Try again is refused for credits", () => {
  it("links to the balance beside the refusal", () => {
    renderCard("repurpose/source_blocked", {
      retryError: "You have 0.4 credits left, which is not enough to process a minute of video.",
      retrySeeCredits: true,
    });
    expect(screen.getByTestId("stage-error-retry-credits")).toHaveAttribute("href", "/billing");
  });

  it("offers no second link on a card that already leads with the balance", () => {
    renderCard("repurpose/no_credits", {
      retryError: "You are out of credits.",
      retrySeeCredits: true,
    });
    expect(screen.getByTestId("stage-error-credits")).toBeInTheDocument();
    expect(screen.queryByTestId("stage-error-retry-credits")).toBeNull();
  });

  it("offers no link for a refusal about something else", () => {
    renderCard("repurpose/source_blocked", { retryError: "That did not work." });
    expect(screen.queryByTestId("stage-error-retry-credits")).toBeNull();
  });
});

describe("<StageErrorCard /> with the numbers behind other refusals", () => {
  it("states a too-large video's size against the plan's cap", () => {
    const mb = 1024 * 1024;
    renderCard("repurpose/source_too_large", {
      detail: { approximateBytes: 556 * mb, maxBytes: 500 * mb },
    });
    expect(screen.getByTestId("stage-error-title")).toHaveTextContent(
      "This video is about 556 MB. Your plan takes files up to 500 MB.",
    );
  });

  // The number is a snapshot from when the run stopped: said in the past, it
  // stays true after a top-up, where "you have 3.5 credits" would not.
  it("says how many credits the run stopped with when out of credits", () => {
    renderCard("repurpose/no_credits", { detail: { creditsLeft: 3.5 } });
    expect(screen.getByTestId("stage-error-reassurance")).toHaveTextContent(
      "This run stopped with 3.5 credits left, and making its transcript needed more than that.",
    );
    expect(screen.getByTestId("stage-error-reassurance")).not.toHaveTextContent(/You have/);
    expect(screen.getByTestId("stage-error-credits")).toHaveAttribute("href", "/billing");
  });
});
