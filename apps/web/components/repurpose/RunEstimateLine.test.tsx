import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RunEstimateLine,
  creditsText,
  estimateText,
  knownDurationOf,
  runsOf,
} from "./RunEstimateLine";
import { EMPTY_START_FORM, type StartFormValue } from "./SourceStartForm";

import type { RunEstimate } from "./results/use-results";

import { renderWithProviders } from "@/test/harness";

const ESTIMATE: RunEstimate = {
  creditsLeft: 184,
  planWindowMs: 20 * 60_000,
  windowMs: 20 * 60_000,
  maxSourceDurationMs: 12 * 60 * 60_000,
  processMs: 20 * 60_000,
  trimmed: false,
  processCredits: 20,
  finishedVideos: { clips: 10, videos: 40, credits: 15 },
  totalCredits: 35,
};

const LINK: StartFormValue = { ...EMPTY_START_FORM, url: "https://youtu.be/abc123def45" };

describe("creditsText", () => {
  it("says credits as a person reads them", () => {
    expect([1, 0, 38.4, 10_000_178].map(creditsText)).toEqual([
      "1 credit",
      "0 credits",
      "38 credits",
      "1,00,00,178 credits",
    ]);
  });
});

describe("knownDurationOf", () => {
  const known = { link: "youtu.be/abc123def45", durationMs: 34 * 60_000 };

  it("knows a link's length only while the link is still that video", () => {
    expect(knownDurationOf(LINK, undefined, known)).toBe(34 * 60_000);
    expect(
      knownDurationOf({ ...LINK, url: "https://youtu.be/zzzzzzzzzzz" }, undefined, known),
    ).toBe(undefined);
    expect(knownDurationOf(LINK, undefined, undefined)).toBe(undefined);
  });

  it("leaves out what a picked start skips", () => {
    expect(knownDurationOf({ ...LINK, startAt: "10:00" }, undefined, known)).toBe(24 * 60_000);
    expect(knownDurationOf({ ...LINK, startAt: "40:00" }, undefined, known)).toBe(undefined);
  });

  it("uses a file's own length, for one file", () => {
    const file = new File(["x"], "talk.mp4", { type: "video/mp4" });
    const upload: StartFormValue = { ...EMPTY_START_FORM, tab: "upload", file };
    expect(knownDurationOf(upload, 90_000, undefined)).toBe(90_000);
    expect(knownDurationOf({ ...upload, files: [file, file] }, 90_000, undefined)).toBe(undefined);
  });
});

describe("runsOf", () => {
  it("counts one run per link or file", () => {
    expect(runsOf(LINK)).toBe(1);
    expect(
      runsOf({
        ...EMPTY_START_FORM,
        tab: "links",
        links: "https://youtu.be/abc123def45\nhttps://youtu.be/zzzzzzzzzzz\n",
      }),
    ).toBe(2);
  });
});

describe("estimateText", () => {
  it("says about what a video of known length costs, and what Autopilot makes", () => {
    expect(
      estimateText(
        { ...ESTIMATE, processMs: 12 * 60_000, processCredits: 12 },
        { known: true, runs: 1 },
      ),
    ).toEqual({
      headline: "about 35 credits",
      detail:
        "Finding clips in 12 minutes of video costs 12 credits, then about 40 finished videos (10 clips in 4 sizes, captions burned in) for 15 credits.",
    });
  });

  it("gives the most a run costs when the length is not known", () => {
    expect(
      estimateText(
        { ...ESTIMATE, finishedVideos: null, totalCredits: 20 },
        { known: false, runs: 3 },
      ),
    ).toEqual({
      headline: "Each video: up to 20 credits",
      detail:
        "For a video of 20 minutes or longer: finding clips costs 1 credit a minute. A shorter video costs less.",
    });
  });
});

describe("RunEstimateLine", () => {
  it("shows the cost and the balance above the start button", async () => {
    const { fetchMock } = renderWithProviders(<RunEstimateLine value={LINK} />, {
      routes: { "/repurpose/estimate": ESTIMATE },
    });
    expect(await screen.findByTestId("run-estimate-headline")).toHaveTextContent(
      "Up to 35 credits",
    );
    expect(screen.getByTestId("run-estimate")).toHaveTextContent("you have 184 credits");
    expect(screen.queryByTestId("run-estimate-short")).not.toBeInTheDocument();
    const url = String(
      fetchMock.mock.calls.find(([u]) => String(u).includes("/repurpose/estimate"))?.[0],
    );
    expect(url).toContain("automation=auto");
    expect(url).toContain("clipLength=medium");
    expect(url).not.toContain("durationMs");
  });

  it("says when the run may cost more than the balance", async () => {
    renderWithProviders(<RunEstimateLine value={LINK} />, {
      routes: { "/repurpose/estimate": { ...ESTIMATE, creditsLeft: 30 } },
    });
    expect(await screen.findByTestId("run-estimate-short")).toBeInTheDocument();
  });

  it("says plainly when there is not a minute's worth of credits", async () => {
    renderWithProviders(<RunEstimateLine value={LINK} />, {
      routes: { "/repurpose/estimate": { ...ESTIMATE, creditsLeft: 0, windowMs: 0, processMs: 0 } },
    });
    const line = await screen.findByTestId("run-estimate");
    expect(line).toHaveAttribute("data-state", "no-credits");
    expect(line).toHaveTextContent("not enough to process a minute of video");
  });

  it("asks for the manual run's cost without Autopilot's videos", async () => {
    const { fetchMock } = renderWithProviders(
      <RunEstimateLine value={{ ...LINK, autopilot: false, method: "manual" }} />,
      { routes: { "/repurpose/estimate": { ...ESTIMATE, finishedVideos: null } } },
    );
    await screen.findByTestId("run-estimate");
    const url = String(
      fetchMock.mock.calls.find(([u]) => String(u).includes("/repurpose/estimate"))?.[0],
    );
    expect(url).toContain("automation=manual");
    expect(url).not.toContain("clipLength");
  });
});
