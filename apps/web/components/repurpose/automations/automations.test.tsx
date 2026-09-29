import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EMPTY_RUN_SETUP,
  runSetupRequest,
  runSetupValueOf,
  validateRunSetup,
} from "@/components/repurpose/RunSetupFields";
import {
  MAX_LINKS,
  linkLinesOf,
  linksToSend,
  severalLinksProblem,
  youtubeVideoIdOf,
} from "@/components/repurpose/several-links";
import { linesOfBulk, refusalText } from "@/components/repurpose/SeveralResults";
import { notificationHref, notificationText } from "@/components/shell/notification-copy";
import { Sidebar } from "@/components/shell/sidebar";
import { renderWithProviders } from "@/test/harness";

/** Channel automations and several at once (2026-10-02): the pure parts, the bell and the nav. */

describe("several links", () => {
  it("reads each line as the API will, and counts the same video once", () => {
    const lines = linkLinesOf(
      [
        "youtu.be/dQw4w9WgXcQ",
        "",
        "  https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30  ",
        "Watch this https://youtu.be/aaaaaaaaaaa?si=x",
        "not a link",
        "https://m.youtube.com/shorts/bbbbbbbbbbb",
      ].join("\n"),
    );
    expect(lines.map((line) => [line.line, line.duplicateOf, line.problem === null])).toEqual([
      [1, null, true],
      [3, 1, true],
      [4, null, true],
      [5, null, false],
      [6, null, true],
    ]);
    expect(linksToSend(lines)).toEqual([
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/aaaaaaaaaaa?si=x",
      "https://m.youtube.com/shorts/bbbbbbbbbbb",
    ]);
    expect(severalLinksProblem(lines)).toBe("Some lines are not links. Fix or remove them.");
  });

  it("asks for at least one link and at most twenty videos", () => {
    expect(severalLinksProblem(linkLinesOf(" \n\n"))).toBe(
      "Paste your YouTube links, one per line.",
    );
    const many = Array.from(
      { length: MAX_LINKS + 2 },
      (_, i) => `https://youtu.be/${String(i).padStart(11, "v")}`,
    ).join("\n");
    expect(severalLinksProblem(linkLinesOf(many))).toBe("Up to 20 videos at a time. Remove 2.");
    // Twenty links to one video is one video.
    const same = Array.from({ length: 25 }, () => "https://youtu.be/dQw4w9WgXcQ").join("\n");
    expect(severalLinksProblem(linkLinesOf(same))).toBeUndefined();
  });

  it("knows a YouTube video however it is written, and nothing else", () => {
    for (const link of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/live/dQw4w9WgXcQ?feature=share",
    ]) {
      expect(youtubeVideoIdOf(link), link).toBe("dQw4w9WgXcQ");
    }
    for (const link of [
      "https://evil.test/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/short",
      "nope",
    ]) {
      expect(youtubeVideoIdOf(link), link).toBeUndefined();
    }
  });

  it("says each bulk line in the page's words, never the API's", () => {
    const lines = linesOfBulk([
      {
        index: 0,
        link: "a",
        outcome: "started",
        runId: "01JRUN0000000000000000000A",
        code: null,
        message: null,
      },
      {
        index: 1,
        link: "b",
        outcome: "duplicate",
        runId: null,
        code: null,
        message: "The same video as line 1.",
      },
      {
        index: 2,
        link: "c",
        outcome: "refused",
        runId: null,
        code: "jobs/concurrency_cap",
        message: "2 jobs in flight",
      },
      {
        index: 3,
        link: "d",
        outcome: "refused",
        runId: null,
        code: "common/rate_limited",
        message: "x",
      },
      {
        index: 4,
        link: "e",
        outcome: "refused",
        runId: null,
        code: "something/new",
        message: "internal words",
      },
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "Started",
      "The same video as line 1.",
      "Your other videos are still being prepared. Try again in about a minute.",
      "You have started many videos in the last hour. Start the rest a little later.",
      "The run could not be started. Try again in a moment.",
    ]);
    expect(refusalText(null)).toBe("The run could not be started. Try again in a moment.");
  });
});

describe("the setup a channel's runs start with", () => {
  it("is always our moments on Autopilot, whatever the panel held", () => {
    const setup = runSetupRequest(
      { ...EMPTY_RUN_SETUP, method: "manual", autopilot: false, topic: "cricket" },
      { forChannel: true },
    );
    expect(setup).toMatchObject({
      automation: "auto",
      discovery: { mode: "ai", requestedCandidates: 5, topic: "cricket", clipLength: "medium" },
    });
    // The start form's own reading is unchanged.
    expect(
      runSetupRequest({ ...EMPTY_RUN_SETUP, method: "manual", autopilot: false }),
    ).toMatchObject({
      automation: "manual",
      discovery: { mode: "manual", requestedCandidates: 0 },
    });
  });

  it("reads a saved setup back into the panel, and sends it again unchanged", () => {
    const saved = runSetupRequest(
      {
        ...EMPTY_RUN_SETUP,
        sourceLanguage: "hi-Latn",
        outputLanguage: "hi",
        scriptMode: "roman",
        topic: "money habits",
        clipLength: "long",
        skipIntro: "1.5",
        skipOutro: "2",
        requestedCandidates: 8,
      },
      { forChannel: true },
    );
    const value = runSetupValueOf(saved);
    expect(value).toMatchObject({
      sourceLanguage: "hi-Latn",
      outputLanguage: "hi",
      scriptMode: "roman",
      topic: "money habits",
      clipLength: "long",
      skipIntro: "1.5",
      skipOutro: "2",
      requestedCandidates: 8,
      autopilot: true,
      method: "ai",
    });
    expect(runSetupRequest(value, { forChannel: true })).toEqual(saved);
    expect(validateRunSetup(value)).toEqual({});
    expect(validateRunSetup({ ...value, styleId: " ", skipIntro: "abc" })).toMatchObject({
      style: "Choose a caption look.",
      skipIntro: "Type a number of minutes from 0 to 30.",
    });
  });
});

describe("the bell", () => {
  const t = (key: string, values?: Record<string, string | number>): string =>
    `${key}${values === undefined ? "" : JSON.stringify(values)}`;
  const ORIGIN = "https://app.example.test";

  it("says a new episode was found and opens its run", () => {
    const item = {
      kind: "watch-new-video",
      data: { channel: "Asha Cooks", video: "Episode 42", runId: "01JRXN0000000000000000000A" },
    };
    expect(notificationText(item, t, ORIGIN)).toEqual({
      title: "notifications.watchNewVideo.title",
      body: 'notifications.watchNewVideo.body{"channel":"Asha Cooks","video":"Episode 42"}',
      href: "/repurpose/01JRXN0000000000000000000A",
      tone: "done",
    });
  });

  it("says why an automation paused and opens Automations", () => {
    const item = {
      kind: "watch-paused",
      data: { channel: "Asha Cooks", reason: "credits", link: `${ORIGIN}/repurpose/automations` },
    };
    expect(notificationText(item, t, ORIGIN)).toMatchObject({
      title: 'notifications.watchPaused.title{"reason":"credits"}',
      tone: "yours",
    });
    expect(notificationHref(item, ORIGIN)).toBe("/repurpose/automations");
    // Missing its channel, it still reads as something.
    expect(notificationText({ kind: "watch-paused", data: {} }, t, ORIGIN).body).toBe(
      'notifications.watchPaused.body{"reason":"other","channel":"notifications.channel"}',
    );
  });
});

describe("the nav", () => {
  const entitlement = (flags: Record<string, boolean>) => ({
    "/workspaces/01JWORKSPACE/entitlement": {
      workspaceId: "01JWORKSPACE",
      planKey: "free",
      planName: "Free",
      creditsPerMonthTenths: 200,
      seatsIncluded: 1,
      seatsUsed: 1,
      computedAt: "2026-10-02T10:00:00.000Z",
      entitlements: { flags },
    },
  });

  it("lists Automations only where it is on", async () => {
    renderWithProviders(<Sidebar />, { routes: entitlement({ repurpose_flow: true }) });
    await waitFor(() => {
      expect(screen.getByTestId("nav-repurpose").tagName).toBe("A");
    });
    expect(screen.queryByTestId("nav-automations")).toBeNull();
  });

  it("links it once the workspace has automations", async () => {
    renderWithProviders(<Sidebar />, {
      routes: entitlement({ repurpose_flow: true, repurpose_automations: true }),
    });
    const entry = await screen.findByTestId("nav-automations");
    expect(entry).toHaveAttribute("href", "/repurpose/automations");
    expect(entry).toHaveTextContent("Automations");
  });
});
