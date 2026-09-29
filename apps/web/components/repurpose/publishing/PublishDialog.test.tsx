import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PublishDialog } from "./PublishDialog";

import type { PlanChannel, PublishPlan } from "./use-publishing";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const CLIP = "01JS00000000000000000CL1PA";
const PLAN_PATH = `/repurpose/runs/${RUN}/clips/${CLIP}/publish-plan`;
const POST_PATH = `/repurpose/runs/${RUN}/clips/${CLIP}/posts`;
const EPISODE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function channel(over: Partial<PlanChannel>): PlanChannel {
  return {
    id: "01JS0000000000000000CHANIG",
    provider: "instagram",
    platform: "Instagram",
    name: "Crest Mond",
    username: "crestmond",
    avatarUrl: null,
    supported: true,
    disabled: false,
    note: null,
    surface: "Reel",
    shape: "9:16",
    ready: true,
    ...over,
  };
}

const PLAN: PublishPlan = {
  status: {
    enabled: true,
    available: true,
    reason: null,
    message: null,
    postizUrl: "http://localhost:4007",
    channelCount: 3,
  },
  clip: { id: CLIP, title: "Why most people never save", durationMs: 31_000 },
  channels: [
    channel({}),
    channel({
      id: "01JS0000000000000000CHANLI",
      provider: "linkedin",
      platform: "LinkedIn",
      name: "Crest Mond Page",
      username: null,
      surface: "Video",
      shape: "1:1",
    }),
    channel({
      id: "01JS00000000000000000CHANX",
      provider: "x",
      platform: "X",
      name: "crestmond",
      username: null,
      surface: "Video",
      shape: null,
      ready: false,
      note: "Too long for X: 2:20 at most.",
    }),
  ],
  texts: {
    instagram: {
      title: null,
      body: `Why most people never save\n\nWatch the full episode: ${EPISODE}`,
      bodyLimit: 2200,
      titleLimit: null,
      titleRequired: false,
      linkLength: null,
    },
    linkedin: {
      title: null,
      body: "Why most people never save",
      bodyLimit: 3000,
      titleLimit: null,
      titleRequired: false,
      linkLength: null,
    },
    x: {
      title: null,
      body: "Why most people never save",
      bodyLimit: 280,
      titleLimit: null,
      titleRequired: false,
      linkLength: 23,
    },
  },
  visibility: { youtube: "public", tiktok: "private" },
  defaults: { timezone: "Asia/Kolkata", dailyTime: "19:00" },
  nextDaily: { "01JS0000000000000000CHANIG": "2026-10-01T13:30:00.000Z" },
};

function sent(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === POST_PATH)
    .map(([, init]) => {
      const request = init as RequestInit;
      return {
        body: JSON.parse(String(request.body)) as Record<string, unknown>,
        headers: request.headers as Record<string, string>,
      };
    });
}

function open(routes: Record<string, unknown>, onOpenChange = vi.fn()) {
  return {
    onOpenChange,
    ...renderWithProviders(
      <PublishDialog
        runId={RUN}
        clipId={CLIP}
        title="Why most people never save"
        open
        onOpenChange={onOpenChange}
      />,
      { routes },
    ),
  };
}

describe("<PublishDialog />", () => {
  it("lists each account under its platform with the shape it gets, and says why one cannot", async () => {
    open({ [PLAN_PATH]: PLAN });
    const instagram = await screen.findByTestId("publish-channel-01JS0000000000000000CHANIG");
    expect(instagram).toHaveTextContent("Crest Mond");
    expect(instagram).toHaveTextContent("Reel · 9:16");
    const x = screen.getByTestId("publish-channel-01JS00000000000000000CHANX");
    expect(x).toHaveTextContent("Too long for X: 2:20 at most.");
    expect(within(x).getByRole("checkbox")).toBeDisabled();
    // Nothing is ticked for the person.
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeChecked();
    }
    expect(screen.getByTestId("publish-confirm")).toBeDisabled();
  });

  it("posts now to the ticked accounts, with each platform's text as edited", async () => {
    const user = userEvent.setup();
    const { fetchMock, onOpenChange } = open({
      [PLAN_PATH]: PLAN,
      [POST_PATH]: { batchId: "01JS000000000000000BATCH01", posts: [] },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Crest Mond @crestmond/ }));
    await user.click(screen.getByRole("checkbox", { name: /Crest Mond Page/ }));

    const caption = screen.getByLabelText("Instagram caption");
    expect(caption).toHaveValue(`Why most people never save\n\nWatch the full episode: ${EPISODE}`);
    const linkedin = screen.getByLabelText("LinkedIn post");
    await user.clear(linkedin);
    await user.type(linkedin, "My own words.");

    const confirm = screen.getByTestId("publish-confirm");
    expect(confirm).toHaveTextContent("Post to 2 accounts");
    await user.click(confirm);
    await waitFor(() => {
      expect(sent(fetchMock)).toHaveLength(1);
    });
    const [request] = sent(fetchMock);
    expect(request?.body).toEqual({
      channelIds: ["01JS0000000000000000CHANIG", "01JS0000000000000000CHANLI"],
      texts: {
        instagram: { body: `Why most people never save\n\nWatch the full episode: ${EPISODE}` },
        linkedin: { body: "My own words." },
      },
      visibility: {},
      when: { kind: "now" },
    });
    expect(request?.headers["Idempotency-Key"]).toMatch(/.{8,}/);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("adds a clip to one a day at 7 pm India time, and shows the day it lands on", async () => {
    const user = userEvent.setup();
    const { fetchMock } = open({
      [PLAN_PATH]: PLAN,
      [POST_PATH]: { batchId: "01JS000000000000000BATCH01", posts: [] },
    });
    await user.click(await screen.findByRole("checkbox", { name: /Crest Mond @crestmond/ }));
    await user.click(screen.getByTestId("publish-when-daily"));
    expect(screen.getByTestId("publish-next-daily")).toHaveTextContent("Instagram, Crest Mond:");
    await user.click(screen.getByTestId("publish-confirm"));
    await waitFor(() => {
      expect(sent(fetchMock)[0]?.body["when"]).toEqual({
        kind: "daily",
        time: "19:00",
        timezone: "Asia/Kolkata",
      });
    });
  });

  it("holds a text that is too long for the platform", async () => {
    const user = userEvent.setup();
    const plan: PublishPlan = {
      ...PLAN,
      channels: PLAN.channels.map((entry) =>
        entry.provider === "x" ? { ...entry, ready: true, note: null, shape: "1:1" } : entry,
      ),
    };
    open({ [PLAN_PATH]: plan });
    await user.click(await screen.findByRole("checkbox", { name: "crestmond" }));
    const text = screen.getByLabelText("X post");
    await user.clear(text);
    await user.click(text);
    await user.paste("a".repeat(281));
    expect(screen.getByTestId("publish-count-x")).toHaveTextContent("281 / 280");
    expect(screen.getByTestId("publish-problems")).toHaveTextContent("The x post is too long.");
    expect(screen.getByTestId("publish-confirm")).toBeDisabled();
  });

  it("shows the server's refusal as a sentence", async () => {
    const user = userEvent.setup();
    open({
      [PLAN_PATH]: PLAN,
      [POST_PATH]: new Response(
        JSON.stringify({
          error: {
            code: "publishing/already_posted",
            message: "This clip already has a post for Crest Mond at that time.",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
    await user.click(await screen.findByRole("checkbox", { name: /Crest Mond @crestmond/ }));
    await user.click(screen.getByTestId("publish-confirm"));
    expect(await screen.findByTestId("publish-error")).toHaveTextContent(/already has a post/);
  });

  it("says in one sentence how to set it up when posting is not available", async () => {
    open({
      [PLAN_PATH]: {
        ...PLAN,
        status: { ...PLAN.status, available: false, reason: "not_configured", channelCount: 0 },
        channels: [],
      },
    });
    const note = await screen.findByTestId("publish-unavailable");
    expect(note).toHaveTextContent("Posting to your accounts is not set up yet.");
    expect(within(note).getByRole("link", { name: "See how to set it up" })).toHaveAttribute(
      "href",
      "/settings/publishing",
    );
  });
});
