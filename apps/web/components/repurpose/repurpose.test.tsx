import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import type { RepurposeRunView, RepurposeStageView } from "@montaj/api-client";

import { SAFE_ERROR_COPY, STAGE_COPY, beginnerSafetyViolations, safeErrorCopy } from "./copy";
import { PersistentPreview, RunActionBar } from "./RunActionBar";
import { RunStageRail } from "./RunStageRail";
import {
  DEFAULT_STYLE_ID,
  EMPTY_START_FORM,
  RECOMMENDED_STYLES,
  SourceStartForm,
  startAtMs,
  validateStartForm,
  type StartFormValue,
} from "./SourceStartForm";
import { StageErrorCard, StagePanel, StageSummary } from "./StagePanel";

import { PipelineBanner } from "@/components/home/pipeline-banner";
import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

/** The entitlement snapshot shape the flag hook reads. */
const ENTITLEMENT = {
  workspaceId: "01JWORKSPACE",
  planKey: "free",
  planName: "Free",
  creditsPerMonthTenths: 200,
  seatsIncluded: 1,
  seatsUsed: 1,
  computedAt: "2026-09-15T10:00:00.000Z",
};

/**
 * The guided repurposing shell (REP-007 / REP-008).
 *
 * The claims worth testing are the product rules, not the markup: the rail is
 * always five fixed stages, a state is never colour alone, a failed stage says
 * whether the work is safe and offers exactly one recommended action, the start
 * form refuses an unattested link, and nothing anywhere says "queue".
 */

function stages(current: number, failed = false): RepurposeStageView[] {
  const keys = [
    "getting_video",
    "finding_clips",
    "styles_formats",
    "review",
    "publish",
  ] as const;
  return keys.map((stage, index) => ({
    stage,
    state:
      index < current
        ? "complete"
        : index > current
          ? "waiting"
          : failed
            ? "failed"
            : "running",
    // eslint-disable-next-line security/detect-object-injection -- `stage` comes from the local literal list above
    label: STAGE_COPY[stage].title,
  }));
}

/**
 * The fields the API adds with plan limits (2026-09-27), as a run that has
 * none of them: spread in, so these fixtures compile whether the client's
 * `RepurposeRunView` declares them yet or not.
 */
const NO_PLAN_LIMIT_FACTS = {
  sourceTitle: null,
  window: null,
  failureDetail: null,
  nextWindowAvailable: false,
};

const RUN: RepurposeRunView = {
  ...NO_PLAN_LIMIT_FACTS,
  id: "01JS0000000000000000000RUN",
  workspaceId: "01JWORKSPACE00000000000000",
  sourceProjectId: "01JPROJECT0000000000000000",
  sourceKind: "youtube_url",
  sourceDisplay: "youtube.com · dQw4w9WgXcQ",
  mode: "ai",
  status: "transcribing",
  currentStage: "finding_clips",
  progress: 30,
  stages: stages(1),
  message: "Creating the transcript.",
  failureCode: null,
  canCancel: true,
  canRetry: false,
  candidateCount: 0,
  clipCount: 0,
  variantCount: 0,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:01:00.000Z",
};

describe("<RunStageRail />", () => {
  it("always draws the same five stages in the same order", () => {
    render(<RunStageRail stages={stages(2)} />);
    const nodes = screen.getAllByRole("listitem");
    expect(nodes).toHaveLength(5);
    expect(nodes.map((node) => node.getAttribute("data-testid"))).toEqual([
      "stage-node-getting_video",
      "stage-node-finding_clips",
      "stage-node-styles_formats",
      "stage-node-review",
      "stage-node-publish",
    ]);
  });

  it("states each step's position and state in words, not only in colour", () => {
    render(<RunStageRail stages={stages(1)} />);
    // A screen reader has to hear "step 2 of 5" and "in progress".
    expect(
      screen.getByRole("button", { name: /Step 2 of 5: Find clips\. In progress\./ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Step 1 of 5: Add video\. Done\./ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Step 5 of 5: Publish\. Not started\./ }),
    ).toBeInTheDocument();
  });

  it("marks only the running step as the current one", () => {
    render(<RunStageRail stages={stages(2)} />);
    const current = screen.getAllByRole("button").filter(
      (button) => button.getAttribute("aria-current") === "step",
    );
    expect(current).toHaveLength(1);
  });

  it("opens a completed stage, and explains a future one instead of doing nothing", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onBlocked = vi.fn();
    render(<RunStageRail stages={stages(1)} onOpenStage={onOpen} onBlockedStage={onBlocked} />);

    await user.click(screen.getByTestId("stage-node-getting_video").querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith("getting_video");

    await user.click(screen.getByTestId("stage-node-publish").querySelector("button")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith("publish", expect.stringContaining("Publish"));
  });
});

describe("<StagePanel />", () => {
  it("announces progress in a live region", () => {
    render(<StagePanel stage="finding_clips" message="Creating the transcript." busy />);
    const status = screen.getByTestId("stage-status-finding_clips");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Creating the transcript.");
  });

  it("tells someone they may leave the page while work is running", () => {
    render(<StagePanel stage="finding_clips" message="Working." busy />);
    expect(screen.getByTestId("background-note")).toHaveTextContent(/leave this page/i);
  });

  it("collapses a finished stage to one line with a way back in", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<StageSummary stage="getting_video" summary="Hindi · 42 minutes" onEdit={onEdit} />);
    await user.click(screen.getByTestId("stage-edit-getting_video"));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});

describe("<StageErrorCard />", () => {
  it("says what happened, that the work is safe, one action, and a support code", () => {
    render(
      <StageErrorCard
        code="repurpose/highlights_failed"
        supportCode="01JS0000000000000000000RUN"
        onRetry={() => undefined}
        onChooseAnother={() => undefined}
      />,
    );

    expect(screen.getByText("We could not finish finding moments")).toBeInTheDocument();
    expect(screen.getByText(/safe/i)).toBeInTheDocument();
    expect(screen.getByTestId("stage-error-retry")).toHaveTextContent("Try again");
    expect(screen.getByTestId("support-code")).toHaveTextContent("01JS0000000000000000000RUN");
  });

  it("offers no retry for a permanent failure, only a way forward", () => {
    render(
      <StageErrorCard
        code="repurpose/source_unsupported"
        supportCode="01JS"
        onRetry={() => undefined}
        onChooseAnother={() => undefined}
      />,
    );
    expect(screen.queryByTestId("stage-error-retry")).toBeNull();
    expect(screen.getByTestId("stage-error-choose-another")).toHaveTextContent(
      "Choose another video",
    );
  });

  it("still produces a sentence for a code this build has never seen", () => {
    // The alternative is rendering `repurpose/whatever_this_is` to a person.
    render(<StageErrorCard code="repurpose/from_the_future" supportCode="01JS" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByText(/from_the_future/)).toBeNull();
  });

  it("is an alert, and never relies on colour alone", () => {
    render(<StageErrorCard code={null} supportCode="01JS" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
  });
});

describe("<PersistentPreview />", () => {
  it("shows the safe display form of the source, never a raw link", () => {
    render(<PersistentPreview run={RUN} />);
    expect(screen.getByTestId("preview-source")).toHaveTextContent("youtube.com · dQw4w9WgXcQ");
    expect(screen.queryByText(/https:\/\//)).toBeNull();
  });

  it("names an upload without inventing a source", () => {
    render(<PersistentPreview run={{ ...RUN, sourceKind: "upload", sourceDisplay: null }} />);
    expect(screen.getByTestId("preview-source")).toHaveTextContent("Your upload");
  });
});

describe("<RunActionBar />", () => {
  it("renders at most one primary and one secondary action", async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    render(
      <RunActionBar
        note="Nothing is posted anywhere without your confirmation."
        secondary={{ label: "Stop this run", onClick: stop, testId: "run-cancel" }}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    await user.click(screen.getByTestId("run-cancel"));
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("start form validation", () => {
  const withLink: StartFormValue = {
    ...EMPTY_START_FORM,
    tab: "link",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    sourceLanguage: "hi-Latn",
    rightsAttested: true,
  };

  it("accepts an attested https link with a language", () => {
    expect(validateStartForm(withLink)).toEqual({});
  });

  it("requires the rights attestation for a link", () => {
    expect(validateStartForm({ ...withLink, rightsAttested: false }).rights).toBeDefined();
  });

  // 2026-09-26: `/repurpose` and Home accept a scheme-less link on purpose and
  // hand it here, where it used to be refused. It is normalised to https now —
  // the API still refuses anything that is not — and only a non-link fails.
  it("accepts a scheme-less or http link, because it is sent as https", () => {
    expect(validateStartForm({ ...withLink, url: "youtube.com/watch?v=dQw4w9WgXcQ" }).url).toBeUndefined();
    expect(
      validateStartForm({ ...withLink, url: "http://www.youtube.com/watch?v=x" }).url,
    ).toBeUndefined();
    expect(
      validateStartForm({ ...withLink, url: "Watch this https://youtu.be/dQw4w9WgXcQ" }).url,
    ).toBeUndefined();
  });

  it("still refuses something that is not a web link", () => {
    expect(validateStartForm({ ...withLink, url: "dQw4w9WgXcQ" }).url).toBeDefined();
    expect(validateStartForm({ ...withLink, url: "ftp://example.com/video.mp4" }).url).toBeDefined();
  });

  it("requires the spoken language rather than guessing it", () => {
    // Guessing silently charges for a transcription in the wrong language.
    expect(validateStartForm({ ...withLink, sourceLanguage: undefined }).sourceLanguage).toBeDefined();
  });

  it("starts with a real caption style, not an empty one", () => {
      // The chip row SHOWS the first style as selected. If that were only a render
      // fallback, every default submit would send "" and the API would 400 — which
      // is the whole happy path.
      expect(DEFAULT_STYLE_ID).not.toBe("");
      expect(EMPTY_START_FORM.styleId).toBe(DEFAULT_STYLE_ID);
      expect(RECOMMENDED_STYLES.map((style) => style.id)).toContain(DEFAULT_STYLE_ID);
    });

    it("refuses to submit an empty style id even if one is forced in", () => {
      expect(validateStartForm({ ...withLink, styleId: "" }).style).toBeDefined();
      expect(validateStartForm({ ...withLink, styleId: "   " }).style).toBeDefined();
      expect(validateStartForm(withLink).style).toBeUndefined();
    });

  it("requires a file on the upload tab, and asks for no attestation there", () => {
    const upload: StartFormValue = { ...EMPTY_START_FORM, tab: "upload", sourceLanguage: "en" };
    const problems = validateStartForm(upload);
    expect(problems.file).toBeDefined();
    expect(problems.rights).toBeUndefined();
  });

  // 2026-09-26: an over-cap upload created its run first and was only then
  // refused by the upload, leaving the run on "Getting your video" for ever.
  it("refuses an upload over the plan's cap before any run exists", () => {
    const file = new File(["x"], "talk.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 600 * 1024 * 1024 });
    const upload: StartFormValue = { ...EMPTY_START_FORM, tab: "upload", sourceLanguage: "en", file };
    expect(validateStartForm(upload, { maxFileBytes: 500 * 1024 * 1024 }).file).toBe(
      "This file is larger than your plan allows (up to 500 MB). Choose a smaller copy.",
    );
    expect(validateStartForm(upload, { maxFileBytes: 1024 * 1024 * 1024 }).file).toBeUndefined();
    // An entitlement that has not loaded never blocks.
    expect(validateStartForm(upload).file).toBeUndefined();
  });
});

describe("<SourceStartForm />", () => {
  function Harness({
    onSubmit,
    onValue,
  }: {
    readonly onSubmit: () => void;
    readonly onValue?: (value: StartFormValue) => void;
  }): React.JSX.Element {
    const [value, setValue] = React.useState<StartFormValue>({
      ...EMPTY_START_FORM,
      sourceLanguage: "hi-Latn",
    });
    onValue?.(value);
    return <SourceStartForm value={value} onChange={setValue} onSubmit={onSubmit} />;
  }

  it("offers both sources as equal tabs", () => {
    render(<Harness onSubmit={() => undefined} />);
    expect(screen.getByTestId("source-tab-link")).toBeInTheDocument();
    expect(screen.getByTestId("source-tab-upload")).toBeInTheDocument();
  });

  it("does not submit an unattested link, and says why", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await user.type(screen.getByTestId("source-url"), "https://youtu.be/dQw4w9WgXcQ");
    await user.click(screen.getByTestId("start-run"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-rights")).toBeInTheDocument();
  });

  it("submits once everything it needs is there", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await user.type(screen.getByTestId("source-url"), "https://youtu.be/dQw4w9WgXcQ");
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("submits the style the user was shown as selected, without them touching it", async () => {
      // The regression this pins: the chip rendered as selected while form state
      // held "", so the request carried an empty style id.
      const user = userEvent.setup();
      let latest: StartFormValue | undefined;
      render(
        <Harness
          onSubmit={() => undefined}
          onValue={(value) => {
            latest = value;
          }}
        />,
      );

      await user.type(screen.getByTestId("source-url"), "https://youtu.be/dQw4w9WgXcQ");
      await user.click(screen.getByTestId("rights-attested"));
      await user.click(screen.getByTestId("start-run"));

      expect(latest?.styleId).toBe(DEFAULT_STYLE_ID);
      expect(latest?.styleId).not.toBe("");
      // And the chip the user sees pressed is that same one.
      expect(screen.getByTestId(`style-${DEFAULT_STYLE_ID}`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("names every control group, and every label points at something real", () => {
      render(<Harness onSubmit={() => undefined} />);

      // Both chip/radio groups are real groups with a name...
      expect(screen.getByRole("group", { name: "Caption look" })).toBeInTheDocument();
      expect(
        screen.getByRole("group", { name: "How should the clips be chosen?" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Spoken language" })).toBeInTheDocument();

      // ...and no <label for> points at an id nothing carries, which is what
      // makes a label unclickable and silent to a screen reader.
      const form = screen.getByTestId("repurpose-start-form");
      for (const label of form.querySelectorAll("label[for]")) {
        const target = label.getAttribute("for") ?? "";
        expect(form.querySelector(`#${target}`), `label for="${target}"`).not.toBeNull();
      }
    });

    it("gives the manual path equal billing with the AI one", () => {
    render(<Harness onSubmit={() => undefined} />);
    expect(screen.getByTestId("method-ai")).toBeInTheDocument();
    expect(screen.getByTestId("method-manual")).toBeInTheDocument();
  });

  it("keeps advanced settings collapsed", async () => {
    const user = userEvent.setup();
    render(<Harness onSubmit={() => undefined} />);
    expect(screen.queryByTestId("advanced-panel")).toBeNull();
    await user.click(screen.getByTestId("advanced-toggle"));
    expect(screen.getByTestId("advanced-panel")).toBeInTheDocument();
  });

  it("does not put aspect ratios, music or networks on the first screen", () => {
    render(<Harness onSubmit={() => undefined} />);
    const forbidden = /9:16|aspect|music|instagram|tiktok|b-roll/i;
    expect(screen.queryByText(forbidden)).toBeNull();
  });
});

describe("the copy dictionary", () => {
  it("has a sentence, a reassurance and an action for every safe error", () => {
    for (const [code, copy] of Object.entries(SAFE_ERROR_COPY)) {
      expect(copy.title.length, code).toBeGreaterThan(0);
      expect(copy.reassurance.length, code).toBeGreaterThan(0);
      expect(copy.actionLabel.length, code).toBeGreaterThan(0);
    }
  });

  it("falls back rather than rendering an unknown code", () => {
    expect(safeErrorCopy("nonsense/code").title).toBe("Something went wrong");
    expect(safeErrorCopy(null).title).toBe("Something went wrong");
  });

  it("contains no technical word, anywhere in it", () => {
    const everything = [
      ...Object.values(SAFE_ERROR_COPY).flatMap((copy) => [
        copy.title,
        copy.reassurance,
        copy.actionLabel,
      ]),
      ...Object.values(STAGE_COPY).flatMap((copy) => [copy.title, copy.helper]),
    ];
    for (const text of everything) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
    }
  });
});

describe("<PipelineBanner /> — the studio's front door to the pipeline", () => {
  it("shows nothing when the flag is off for this workspace", async () => {
    // The flag is targeted, so a workspace outside the cohort must see no
    // banner at all — a surface whose every API route answers 404 is worse
    // than none.
    renderWithProviders(<PipelineBanner />, {
      routes: { "/workspaces/01JWORKSPACE/entitlement": { ...ENTITLEMENT, entitlements: { flags: {} } } },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("repurpose-entry")).toBeNull();
    });
  });

  it("shows the pitch, a link field and the stage rail when the flag is on", async () => {
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          ...ENTITLEMENT,
          entitlements: { flags: { repurpose_flow: true } },
        },
      },
    });
    const banner = await screen.findByTestId("repurpose-entry");
    expect(banner).toHaveTextContent("One long video, nine posts");
    expect(screen.getByTestId("pipeline-url")).toBeInTheDocument();
    // The rail draws the five stages the API actually has, not the canvas's
    // ten — two of which (Schedule, Measure) have no endpoint behind them.
    expect(screen.getByTestId("pipeline-stages").children).toHaveLength(5);
  });

  it("hands a pasted link to the start screen rather than posting a run", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelineBanner />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          ...ENTITLEMENT,
          entitlements: { flags: { repurpose_flow: true } },
        },
      },
    });
    await screen.findByTestId("repurpose-entry");
    await user.type(screen.getByTestId("pipeline-url"), "https://youtu.be/dQw4w9WgXcQ");
    await user.click(screen.getByTestId("pipeline-start"));
    // A run needs the rights attestation, a language and a style. None of
    // those can be answered from a one-line field, so the banner navigates.
    expect(routerMock.push).toHaveBeenCalledWith(
      "/repurpose/new?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ",
    );
  });

  it("shows nothing while the entitlement is still loading", () => {
    // An entry point that flickers in and back out is worse than one that
    // appears a moment late, and a gated feature must never be briefly visible.
    renderWithProviders(<PipelineBanner />, { routes: {} });
    expect(screen.queryByTestId("repurpose-entry")).toBeNull();
  });
});

/**
 * Plan limits (2026-09-27). The spoken language starts on "Detect
 * automatically" instead of whatever this browser last picked on Home (a hint
 * that overrides detection), and a link can say where a long video's window
 * starts.
 */
describe("<SourceStartForm /> language and window", () => {
  const LINK = "https://youtu.be/dQw4w9WgXcQ";

  function Harness({
    onSubmit,
    onValue,
    initial = EMPTY_START_FORM,
    ...props
  }: {
    readonly onSubmit: () => void;
    readonly onValue?: (value: StartFormValue) => void;
    readonly initial?: StartFormValue;
  } & Partial<React.ComponentProps<typeof SourceStartForm>>): React.JSX.Element {
    const [value, setValue] = React.useState<StartFormValue>(initial);
    onValue?.(value);
    return <SourceStartForm value={value} onChange={setValue} onSubmit={onSubmit} {...props} />;
  }

  it("starts on 'Detect automatically', with no picker to fill in, and submits that", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    let latest: StartFormValue | undefined;
    render(
      <Harness
        onSubmit={onSubmit}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );

    expect(screen.getByTestId("language-detect")).toBeChecked();
    expect(screen.queryByTestId("quickpick-language")).toBeNull();
    expect(screen.getByTestId("language-detect-hint")).toHaveTextContent(/Hindi and English/);

    await user.type(screen.getByTestId("source-url"), LINK);
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(latest?.sourceLanguage).toBe("auto");
  });

  it("asks for the language once the person says they will choose it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    await user.click(screen.getByTestId("language-choose"));
    expect(screen.getByTestId("quickpick-language")).toBeInTheDocument();
    await user.type(screen.getByTestId("source-url"), LINK);
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-language")).toHaveTextContent(
      "Choose the language spoken in the video.",
    );

    // Back to detecting is a choice again.
    await user.click(screen.getByTestId("language-detect"));
    await user.click(screen.getByTestId("start-run"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  // A start applies to any video: the downloader cuts from it even when the
  // video fits the window, so the line no longer says it is only for long ones.
  it("explains in one line that a long video is processed a part at a time", () => {
    const { unmount } = render(<Harness onSubmit={() => undefined} />);
    expect(
      screen.getByText(
        "Long videos are processed a part at a time: the most-replayed part, unless you choose where to start.",
      ),
    ).toBeInTheDocument();
    unmount();
    render(<Harness onSubmit={() => undefined} planWindowMs={20 * 60_000} />);
    expect(
      screen.getByText(
        "Videos are processed up to 20 minutes at a time: the most-replayed part, unless you choose where to start.",
      ),
    ).toBeInTheDocument();
  });

  it("offers no start on a plan that processes whole videos, and never blocks on a hidden one", async () => {
    const user = userEvent.setup();
    // A start carried in the URL that would be refused if the field were there.
    const carried = { ...EMPTY_START_FORM, url: LINK, rightsAttested: true, startAt: "99:00:00" };
    const blocked = vi.fn();
    const { unmount } = render(<Harness onSubmit={blocked} initial={carried} />);
    await user.click(screen.getByTestId("start-run"));
    expect(blocked).not.toHaveBeenCalled();
    unmount();

    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} initial={carried} processesWholeVideos focusStartAt />);
    expect(screen.queryByTestId("source-start-at")).toBeNull();
    expect(screen.queryByText(/processed a part at a time/)).toBeNull();
    await user.click(screen.getByTestId("start-run"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("puts the cursor in 'Start at' when the person came to pick a start", () => {
    render(<Harness onSubmit={() => undefined} focusStartAt />);
    expect(screen.getByTestId("source-start-at")).toHaveFocus();
  });

  it("refuses a start that is not a time, and one past the end of the video", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Harness onSubmit={onSubmit} knownLength={{ link: LINK, durationMs: 34 * 60_000 + 37_000 }} />,
    );

    await user.type(screen.getByTestId("source-url"), LINK);
    await user.click(screen.getByTestId("rights-attested"));
    await user.type(screen.getByTestId("source-start-at"), "soon");
    await user.click(screen.getByTestId("start-run"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Type the start as m:ss or h:mm:ss, like 12:10.")).toBeInTheDocument();

    await user.clear(screen.getByTestId("source-start-at"));
    await user.type(screen.getByTestId("source-start-at"), "40:00");
    expect(screen.getByText("This video is only 34:37 long.")).toBeInTheDocument();

    await user.clear(screen.getByTestId("source-start-at"));
    await user.type(screen.getByTestId("source-start-at"), "12:10");
    await user.click(screen.getByTestId("start-run"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("holds a known length only while the link is still that video's", () => {
    const knownLength = { link: LINK, durationMs: 34 * 60_000 + 37_000 };
    const form = { ...EMPTY_START_FORM, url: LINK, rightsAttested: true, startAt: "40:00" };
    expect(validateStartForm(form, { knownLength }).startAt).toBe(
      "This video is only 34:37 long.",
    );
    // The same video written another way is still that video.
    expect(
      validateStartForm({ ...form, url: "youtu.be/dQw4w9WgXcQ" }, { knownLength }).startAt,
    ).toBe("This video is only 34:37 long.");
    // Another video: its length is not known, so 40:00 is a fine start.
    expect(
      validateStartForm(
        { ...form, url: "https://www.youtube.com/watch?v=kE0oUEzVVes" },
        { knownLength },
      ).startAt,
    ).toBeUndefined();
  });

  it("refuses a start no video can reach, whether or not the length is known", () => {
    const form = { ...EMPTY_START_FORM, url: LINK, rightsAttested: true };
    const ceiling = "Start within the first 12 hours. No video can be longer than that.";
    expect(validateStartForm({ ...form, startAt: "99:00:00" }).startAt).toBe(ceiling);
    expect(validateStartForm({ ...form, startAt: "12:00:00" }).startAt).toBe(ceiling);
    expect(validateStartForm({ ...form, startAt: "11:59:59" }).startAt).toBeUndefined();
  });

  it("offers no start for an upload, which is processed whole", async () => {
    const user = userEvent.setup();
    render(<Harness onSubmit={() => undefined} />);
    await user.click(screen.getByTestId("source-tab-upload"));
    expect(screen.queryByTestId("source-start-at")).toBeNull();
    expect(startAtMs({ tab: "upload", startAt: "12:10" })).toBeUndefined();
    expect(startAtMs({ tab: "link", startAt: "1:02:30" })).toBe(3_750_000);
    expect(startAtMs({ tab: "link", startAt: "  " })).toBeUndefined();
  });

  it("links to the balance beside a refusal for credits", () => {
    render(
      <Harness
        onSubmit={() => undefined}
        serverError="You have 0.4 credits left, which is not enough to process a minute of video."
        seeCredits
      />,
    );
    expect(screen.getByTestId("start-see-credits")).toHaveAttribute("href", "/billing");
  });
});

describe("<PersistentPreview /> for a run that processed part of its video", () => {
  const WINDOW = {
    startMs: 730_000,
    endMs: 1_930_000,
    sourceDurationMs: 2_077_000,
    policy: "most_replayed",
  } as const;

  it("says which part, so its moments are read against that part", () => {
    const partial: RepurposeRunView = {
      ...RUN,
      status: "candidates_ready",
      currentStage: "finding_clips",
      window: WINDOW,
    };
    render(<PersistentPreview run={partial} />);
    expect(screen.getByTestId("preview-window")).toHaveTextContent(
      "Processed 12:10–32:10 of 34:37 (most replayed)",
    );
  });

  it("does not say 'processed' while the part is still being worked on, or after a failure", () => {
    const { unmount } = render(<PersistentPreview run={{ ...RUN, window: WINDOW }} />);
    expect(screen.getByTestId("preview-window")).toHaveTextContent(
      "Processing 12:10–32:10 of 34:37 (most replayed)",
    );
    unmount();
    render(
      <PersistentPreview
        run={{ ...RUN, status: "failed", failureCode: "repurpose/no_credits", window: WINDOW }}
      />,
    );
    expect(screen.getByTestId("preview-window")).toHaveTextContent(
      "Part 12:10–32:10 of 34:37 (most replayed)",
    );
  });

  it("says nothing of the kind for a whole video, or an API that does not say", () => {
    render(<PersistentPreview run={RUN} />);
    expect(screen.queryByTestId("preview-window")).toBeNull();
  });
});
