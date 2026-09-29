import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { AutomationsView } from "./automations-view";

import type { Watch, WatchList } from "@/components/repurpose/automations/use-automations";

import {
  allAutomationsCopy,
  automationRefusal,
} from "@/components/repurpose/automations/automations-copy";
import {
  looksLikeChannelLink,
  normaliseChannelLink,
} from "@/components/repurpose/automations/channel-link";
import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders, testAccessToken } from "@/test/harness";

/**
 * `/repurpose/automations` (2026-10-02): connect a channel, see what each
 * automation did, pause, resume, change and remove one.
 */
const ENTITLEMENT_PATH = "/workspaces/01JWORKSPACE/entitlement";
const WATCHES = "/repurpose/watches";
const WATCH_ID = "01JWATCH000000000000000000";
const CHANNEL = "UCAksharoTestChannel0001";

const ALL_ON = { repurpose_flow: true, source_youtube_acquire: true, repurpose_automations: true };

function entitlement(flags: Record<string, boolean>): Record<string, unknown> {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 200,
    seatsIncluded: 1,
    seatsUsed: 1,
    computedAt: "2026-10-02T10:00:00.000Z",
    entitlements: { flags },
  };
}

const SETUP = {
  sourceLanguage: "hi-Latn",
  caption: { outputLanguage: "same", scriptMode: "auto" as const, styleId: "punch-pop" },
  discovery: {
    mode: "ai" as const,
    requestedCandidates: 5,
    minDurationMs: 30_000,
    maxDurationMs: 60_000,
    contentGoal: "reach" as const,
    topic: "money habits",
    clipLength: "short" as const,
    skipIntroMs: 120_000,
  },
  automation: "auto" as const,
};

function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: WATCH_ID,
    kind: "youtube_channel",
    channelId: CHANNEL,
    channelUrl: `https://www.youtube.com/channel/${CHANNEL}`,
    title: "Aksharo Test Kitchen",
    handle: "AksharoTestKitchen",
    state: "active",
    stateReason: null,
    message: null,
    setup: SETUP,
    backfillCount: 0,
    lastCheckedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    nextCheckAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    lastErrorCode: null,
    runsStarted: 2,
    videos: [
      {
        videoId: "vid00000002",
        title: "Episode 42",
        publishedAt: "2026-10-02T08:00:00.000Z",
        state: "started",
        reason: null,
        backfill: false,
        runId: "01JRUN0000000000000000000A",
        runStatus: "transcribing",
      },
      {
        videoId: "vid00000003",
        title: "Budget tips #shorts",
        publishedAt: "2026-10-02T09:00:00.000Z",
        state: "skipped",
        reason: "short",
        backfill: false,
        runId: null,
        runStatus: null,
      },
    ],
    createdBy: "01JUSER",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

function list(items: Watch[], extra: Partial<WatchList> = {}): WatchList {
  return { items, checksEnabled: true, maxWatches: 20, ...extra };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (body: unknown) => Response;

/** Answers by method and path; the harness's own table answers the rest (the entitlement). */
function serve(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  handlers: Record<string, Handler>,
): { calls: { key: string; body: unknown }[] } {
  const calls: { key: string; body: unknown }[] = [];
  const through = fetchMock.getMockImplementation() as (
    input: RequestInfo | URL,
  ) => Promise<Response>;
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    // eslint-disable-next-line security/detect-object-injection -- a test's own table
    const handler = handlers[key];
    if (handler === undefined) return through(input);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    calls.push({ key, body });
    return Promise.resolve(handler(body));
  });
  return { calls };
}

function render(flags: Record<string, boolean> = ALL_ON, role = "editor") {
  return renderWithProviders(<AutomationsView />, {
    routes: { [ENTITLEMENT_PATH]: entitlement(flags) },
    accessToken: testAccessToken({ role }),
  });
}

let current: WatchList;

beforeEach(() => {
  current = list([watch()]);
});

describe("<AutomationsView />", () => {
  it("says it is not on yet, and asks the server nothing, while any flag is off", async () => {
    const { fetchMock } = render({ repurpose_flow: true, source_youtube_acquire: true });
    expect(
      await screen.findByText("Automations are not on for this workspace yet"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === WATCHES),
    ).toBe(false);
  });

  it("lists each automation with its state, what it did, and a way into each run", async () => {
    const { fetchMock } = render();
    serve(fetchMock, { [`GET ${WATCHES}`]: () => json(200, current) });

    const card = await screen.findByTestId(`watch-${WATCH_ID}`);
    expect(within(card).getByTestId(`watch-title-${WATCH_ID}`)).toHaveTextContent(
      "Aksharo Test Kitchen",
    );
    expect(within(card).getByTestId(`watch-state-${WATCH_ID}`)).toHaveTextContent("Active");
    expect(within(card).getByTestId(`watch-checked-${WATCH_ID}`)).toHaveTextContent(
      /Checked .* · next look .* · 2 runs started/,
    );
    expect(within(card).getByTestId("watch-video-vid00000002")).toHaveTextContent(
      "Clips on the way",
    );
    expect(within(card).getByTestId("watch-video-open-vid00000002")).toHaveAttribute(
      "href",
      "/repurpose/01JRUN0000000000000000000A",
    );
    expect(within(card).getByTestId("watch-video-vid00000003")).toHaveTextContent(
      "A Short, skipped",
    );
    expect(screen.queryByTestId("automations-checks-off")).toBeNull();
  });

  it("shows a viewer what each automation is doing, without buttons the server would refuse", async () => {
    const { fetchMock } = render(ALL_ON, "viewer");
    serve(fetchMock, { [`GET ${WATCHES}`]: () => json(200, current) });
    expect(await screen.findByTestId(`watch-${WATCH_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId("automations-read-only")).toBeInTheDocument();
    expect(screen.queryByTestId("watch-add-form")).toBeNull();
    expect(screen.queryByTestId(`watch-pause-${WATCH_ID}`)).toBeNull();
    expect(screen.queryByTestId(`watch-remove-${WATCH_ID}`)).toBeNull();
  });

  it("says so when this server is not picking up new videos, and why a watch is paused", async () => {
    current = list(
      [
        watch({
          state: "paused",
          stateReason: "no_credits",
          message:
            "Paused: this workspace ran out of credits. Add credits, then resume it to pick up where it left off.",
          nextCheckAt: null,
        }),
      ],
      { checksEnabled: false },
    );
    const { fetchMock } = render();
    serve(fetchMock, { [`GET ${WATCHES}`]: () => json(200, current) });
    expect(await screen.findByTestId("automations-checks-off")).toBeInTheDocument();
    expect(screen.getByTestId(`watch-state-${WATCH_ID}`)).toHaveTextContent("Paused");
    expect(screen.getByTestId(`watch-message-${WATCH_ID}`)).toHaveTextContent("ran out of credits");
    expect(screen.getByTestId(`watch-resume-${WATCH_ID}`)).toBeInTheDocument();
  });

  it("finds a channel, then saves it with the start form's settings, always on Autopilot", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, {
      [`GET ${WATCHES}`]: () => json(200, list([])),
      [`POST ${WATCHES}/resolve`]: () =>
        json(200, {
          channelId: CHANNEL,
          title: "Aksharo Test Kitchen",
          handle: "AksharoTestKitchen",
          channelUrl: `https://www.youtube.com/channel/${CHANNEL}`,
          watchId: null,
        }),
      [`POST ${WATCHES}`]: () => json(201, watch()),
    });

    await user.type(await screen.findByTestId("watch-link"), "@AksharoTestKitchen");
    // Nothing to save until the channel is found: the one primary waits for it.
    expect(screen.queryByTestId("watch-save")).toBeNull();
    await user.click(screen.getByTestId("watch-find"));
    expect(await screen.findByTestId("watch-preview-title")).toHaveTextContent(
      "Aksharo Test Kitchen",
    );
    expect(calls.find((call) => call.key.endsWith("/resolve"))).toEqual({
      key: `POST ${WATCHES}/resolve`,
      body: { url: "https://www.youtube.com/@AksharoTestKitchen" },
    });

    // The start form's own panel, minus what a channel's runs always are.
    expect(screen.getByTestId("steering-topic")).toBeInTheDocument();
    expect(screen.queryByTestId("method-manual")).toBeNull();
    expect(screen.queryByTestId("autopilot-switch")).toBeNull();
    expect(screen.getByTestId("autopilot-always")).toBeInTheDocument();

    await user.type(screen.getByTestId("steering-topic"), "money habits");
    await user.click(screen.getByTestId("watch-backfill-2"));
    await user.click(screen.getByTestId("watch-save"));
    // The rights box first.
    expect(await screen.findByTestId("watch-error-rights")).toBeInTheDocument();
    expect(calls.filter((call) => call.key === `POST ${WATCHES}`)).toHaveLength(0);

    await user.click(screen.getByTestId("watch-rights"));
    await user.click(screen.getByTestId("watch-save"));
    await waitFor(() => {
      expect(calls.some((call) => call.key === `POST ${WATCHES}`)).toBe(true);
    });
    const saved = calls.find((call) => call.key === `POST ${WATCHES}`)?.body;
    expect(saved).toMatchObject({
      url: "https://www.youtube.com/@AksharoTestKitchen",
      backfill: 2,
      rightsAttested: true,
      setup: {
        sourceLanguage: "auto",
        automation: "auto",
        discovery: { mode: "ai", topic: "money habits", clipLength: "medium" },
      },
    });
    expect(await screen.findByTestId("watch-saved")).toHaveTextContent(
      "Aksharo Test Kitchen is connected",
    );
    // One primary per surface.
    expect(document.querySelectorAll(".text-on-accent").length).toBeLessThanOrEqual(1);
  });

  it("refuses a link that is not a channel before asking anything", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, { [`GET ${WATCHES}`]: () => json(200, list([])) });
    await user.type(
      await screen.findByTestId("watch-link"),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    await user.click(screen.getByTestId("watch-find"));
    expect(await screen.findByText(/Paste a channel link/)).toBeInTheDocument();
    expect(calls.filter((call) => call.key.includes("resolve"))).toHaveLength(0);
  });

  it("says a channel is already followed, and says what YouTube said in its own words", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    let answer: Response = json(200, {
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen",
      handle: null,
      channelUrl: `https://www.youtube.com/channel/${CHANNEL}`,
      watchId: WATCH_ID,
    });
    serve(fetchMock, {
      [`GET ${WATCHES}`]: () => json(200, current),
      [`POST ${WATCHES}/resolve`]: () => answer,
    });
    await user.type(await screen.findByTestId("watch-link"), `youtube.com/channel/${CHANNEL}`);
    await user.click(screen.getByTestId("watch-find"));
    expect(await screen.findByTestId("watch-already")).toBeInTheDocument();
    expect(screen.queryByTestId("watch-save")).toBeNull();

    answer = json(503, { error: { code: "repurpose/youtube_busy", message: "raw api words" } });
    await user.type(screen.getByTestId("watch-link"), "x");
    await user.clear(screen.getByTestId("watch-link"));
    await user.type(screen.getByTestId("watch-link"), "https://www.youtube.com/@Another_one");
    await user.click(screen.getByTestId("watch-find"));
    expect(await screen.findByTestId("watch-add-error")).toHaveTextContent(
      "YouTube is not answering us right now",
    );
    expect(screen.queryByText("raw api words")).toBeNull();
  });

  it("pauses, resumes and removes an automation, the last only once confirmed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, {
      [`GET ${WATCHES}`]: () => json(200, current),
      [`POST ${WATCHES}/${WATCH_ID}/pause`]: () => {
        current = list([watch({ state: "paused", stateReason: "person", nextCheckAt: null })]);
        return json(200, current.items[0]);
      },
      [`POST ${WATCHES}/${WATCH_ID}/resume`]: () => {
        current = list([watch()]);
        return json(200, current.items[0]);
      },
      [`DELETE ${WATCHES}/${WATCH_ID}`]: () => {
        current = list([]);
        return json(200, { id: WATCH_ID });
      },
    });

    await user.click(await screen.findByTestId(`watch-pause-${WATCH_ID}`));
    await user.click(await screen.findByTestId(`watch-resume-${WATCH_ID}`));
    await screen.findByTestId(`watch-pause-${WATCH_ID}`);
    expect(calls.map((call) => call.key).filter((key) => !key.startsWith("GET "))).toEqual([
      `POST ${WATCHES}/${WATCH_ID}/pause`,
      `POST ${WATCHES}/${WATCH_ID}/resume`,
    ]);

    await user.click(screen.getByTestId(`watch-remove-${WATCH_ID}`));
    const dialog = await screen.findByTestId("confirm-action-dialog");
    expect(within(dialog).getByText("Stop following Aksharo Test Kitchen?")).toBeInTheDocument();
    // Cancel is focused first: Enter does not remove anything.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByTestId(`watch-remove-confirm-${WATCH_ID}`));
    await waitFor(() => {
      expect(calls.some((call) => call.key === `DELETE ${WATCHES}/${WATCH_ID}`)).toBe(true);
    });
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
  });

  it("edits the settings its next videos run with, starting from what was saved", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, {
      [`GET ${WATCHES}`]: () => json(200, current),
      [`PATCH ${WATCHES}/${WATCH_ID}`]: (body) =>
        json(200, watch({ setup: (body as { setup: typeof SETUP }).setup })),
    });

    await user.click(await screen.findByTestId(`watch-edit-${WATCH_ID}`));
    const editor = screen.getByTestId(`watch-settings-${WATCH_ID}`);
    const topic = within(editor).getByTestId("steering-topic");
    expect(topic).toHaveValue("money habits");
    expect(within(editor).getByTestId("steering-skip-intro")).toHaveValue("2");
    expect(within(editor).getByTestId("clip-length-short")).toBeChecked();
    await user.clear(topic);
    await user.type(topic, "startup failures");
    await user.click(within(editor).getByTestId(`watch-settings-save-${WATCH_ID}`));

    await waitFor(() => {
      expect(calls.some((call) => call.key === `PATCH ${WATCHES}/${WATCH_ID}`)).toBe(true);
    });
    expect(calls.find((call) => call.key.startsWith("PATCH"))?.body).toMatchObject({
      setup: {
        sourceLanguage: "hi-Latn",
        automation: "auto",
        discovery: {
          mode: "ai",
          topic: "startup failures",
          clipLength: "short",
          skipIntroMs: 120_000,
        },
      },
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`watch-settings-${WATCH_ID}`)).toBeNull();
    });
  });
});

describe("the page's words and links", () => {
  it("never uses a word a person should not have to know", () => {
    for (const sentence of allAutomationsCopy()) {
      expect(beginnerSafetyViolations(sentence), sentence).toEqual([]);
    }
  });

  it("never shows the API's own words for a refusal", () => {
    const refused = (code: string) =>
      automationRefusal(
        Object.assign(new Error("raw"), {
          name: "ApiError",
          code,
          status: 400,
          details: undefined,
          requestId: null,
          retryAfterMs: null,
        }),
      );
    expect(refused("something/unknown")).not.toContain("raw");
    expect(automationRefusal(new Error("socket"))).toMatch(/connection/);
  });

  it("takes a bare handle or a scheme-less link as the channel it names", () => {
    expect(normaliseChannelLink("@AksharoTestKitchen")).toBe(
      "https://www.youtube.com/@AksharoTestKitchen",
    );
    expect(normaliseChannelLink("youtube.com/@AksharoTestKitchen")).toBe(
      "https://youtube.com/@AksharoTestKitchen",
    );
    for (const good of [
      "https://www.youtube.com/@AksharoTestKitchen/videos",
      `https://m.youtube.com/channel/${CHANNEL}`,
      "https://youtube.com/c/AksharoKitchen",
      "https://www.youtube.com/user/aksharo2009",
    ]) {
      expect(looksLikeChannelLink(good), good).toBe(true);
    }
    for (const bad of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://evil.test/@x",
      "http://www.youtube.com/@x",
      "https://www.youtube.com/",
      "javascript:alert(1)",
    ]) {
      expect(looksLikeChannelLink(bad), bad).toBe(false);
    }
  });
});
