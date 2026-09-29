import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientReview } from "./client-review";

import type { ClientClip, ClientReviewPage } from "@/lib/review/client-review";

import { renderWithProviders } from "@/test/harness";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const CLIP_A = "01JS00000000000000000CL1PA";
const CLIP_B = "01JS00000000000000000CL1PB";

function clip(over: Partial<ClientClip> = {}): ClientClip {
  return {
    id: CLIP_A,
    title: "Why most people never save",
    hook: "Stop doing this",
    description: "The one habit that changes everything.",
    hashtags: ["#money", "#saving"],
    durationMs: 30_000,
    video: {
      exportId: "EXP-A",
      url: "https://media.test/ws/a.mp4?X-Amz-Expires=1200",
      durationMs: 30_000,
    },
    yourDecision: null,
    comments: [],
    ...over,
  };
}

function page(over: Partial<ClientReviewPage> = {}): ClientReviewPage {
  return {
    title: "Diwali vlog",
    requireName: false,
    expiresAt: "2026-10-10T06:00:00.000Z",
    clips: [
      clip(),
      clip({
        id: CLIP_B,
        title: "The one habit",
        video: { exportId: "EXP-B", url: "https://media.test/ws/b.mp4", durationMs: 25_000 },
      }),
    ],
    ...over,
  };
}

function requests(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
): { method: string; headers: Record<string, string>; body: unknown }[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => {
      const request = init as RequestInit | undefined;
      return {
        method: request?.method ?? "GET",
        headers: (request?.headers ?? {}) as Record<string, string>,
        body: request?.body === undefined ? null : (JSON.parse(String(request.body)) as unknown),
      };
    });
}

function render(data: ClientReviewPage | Response = page(), extra: Record<string, unknown> = {}) {
  return renderWithProviders(<ClientReview token={TOKEN} />, {
    accessToken: null,
    routes: {
      "/review": data,
      [`/review/clips/${CLIP_A}/decision`]: clip(),
      [`/review/clips/${CLIP_A}/comments`]: {
        id: "N1",
        name: null,
        body: "x",
        atMs: null,
        createdAt: "2026-10-03T06:00:00.000Z",
      },
      ...extra,
    },
  });
}

const PHONE = 390;
let width = 1024;

beforeEach(() => {
  width = window.innerWidth;
  window.localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
});

describe("the client's review page", () => {
  it("lists the clips with their vertical video and words, and asks with the token in a header", async () => {
    const { fetchMock } = render();
    expect(await screen.findByTestId("client-review-title")).toHaveTextContent("Diwali vlog");
    expect(screen.getByText("This link works until 10 October.")).toBeInTheDocument();
    const first = screen.getByTestId(`client-clip-${CLIP_A}`);
    expect(within(first).getByText("Clip 1 of 2")).toBeInTheDocument();
    expect(within(first).getByTestId(`client-video-${CLIP_A}`)).toHaveAttribute(
      "src",
      "https://media.test/ws/a.mp4?X-Amz-Expires=1200",
    );
    expect(within(first).getByText("Stop doing this")).toBeInTheDocument();
    expect(within(first).getByText("#money #saving")).toBeInTheDocument();
    const [open] = requests(fetchMock, "/review");
    expect(open?.headers["x-review-token"]).toBe(TOKEN);
    expect(open?.headers).not.toHaveProperty("Authorization");
    // The token is never in a path the API sees.
    for (const [input] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain(TOKEN);
    }
  });

  it("approves the clip in view as the client, pinned to the video they watched", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    await screen.findByTestId("client-review-title");
    expect(screen.getByTestId("client-decision-target")).toHaveTextContent(
      "Clip 1 of 2 · Why most people never save",
    );
    await user.type(screen.getByTestId("reviewer-name"), "Priya");
    await user.click(screen.getByTestId("client-approve"));
    await waitFor(() => {
      expect(requests(fetchMock, `/review/clips/${CLIP_A}/decision`)).toMatchObject([
        {
          method: "POST",
          headers: { "x-review-token": TOKEN },
          body: { decision: "approved", name: "Priya", expect: "EXP-A" },
        },
      ]);
    });
    // Remembered for the next link this browser opens.
    expect(window.localStorage.getItem("aksharo.review.name")).toBe("Priya");
  });

  it("asks for a name first when the link needs one", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render(page({ requireName: true }));
    await screen.findByTestId("client-review-title");
    expect(screen.getByTestId("client-approve")).toBeDisabled();
    expect(screen.getByLabelText(/Add your name first/)).toBeInTheDocument();
    await user.type(screen.getByTestId("reviewer-name-bar"), "Priya");
    expect(screen.getByTestId("client-approve")).toBeEnabled();
    expect(requests(fetchMock, `/review/clips/${CLIP_A}/decision`)).toEqual([]);
  });

  it("asks what should change, and sends it with the request", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    await screen.findByTestId("client-review-title");
    await user.click(screen.getByTestId("client-request-changes"));
    expect(screen.getByTestId("client-changes-send")).toBeDisabled();
    await user.type(screen.getByTestId("client-changes-note"), "Cut the first two seconds");
    await user.click(screen.getByTestId("client-changes-send"));
    await waitFor(() => {
      expect(requests(fetchMock, `/review/clips/${CLIP_A}/decision`)).toMatchObject([
        {
          body: {
            decision: "changes_requested",
            note: "Cut the first two seconds",
            expect: "EXP-A",
          },
        },
      ]);
    });
  });

  it("says what they decided, and when the clip changed since", async () => {
    render(
      page({
        clips: [
          clip({
            yourDecision: {
              state: "approved",
              at: "2026-10-03T06:00:00.000Z",
              name: "Priya",
              changedSince: true,
            },
            comments: [
              {
                id: "N1",
                name: "Priya",
                body: "Love the ending",
                atMs: 21_000,
                createdAt: "2026-10-03T06:00:00.000Z",
              },
            ],
          }),
        ],
      }),
    );
    expect(await screen.findByTestId(`client-decision-${CLIP_A}`)).toHaveTextContent(
      "You approved this",
    );
    expect(screen.getByTestId(`client-changed-${CLIP_A}`)).toHaveTextContent(
      "A new version was made after you decided.",
    );
    expect(screen.getByTestId("client-comment-N1")).toHaveTextContent("Love the ending");
    expect(screen.getByRole("button", { name: "Play from 0:21" })).toBeInTheDocument();
  });

  it("pins a comment to where the video is playing", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render();
    await screen.findByTestId("client-review-title");
    const video = screen.getByTestId(`client-video-${CLIP_A}`);
    Object.defineProperty(video, "currentTime", { configurable: true, value: 12.4 });
    fireEvent.timeUpdate(video);
    expect(await screen.findByText("At 0:12 in the clip")).toBeInTheDocument();
    await user.type(screen.getByTestId(`client-comment-${CLIP_A}-body`), "Too quiet here");
    await user.click(screen.getByTestId(`client-comment-${CLIP_A}-post`));
    await waitFor(() => {
      expect(requests(fetchMock, `/review/clips/${CLIP_A}/comments`)).toMatchObject([
        { body: { body: "Too quiet here", atMs: 12_400 } },
      ]);
    });
  });

  it("says when there is nothing to review yet", async () => {
    render(page({ clips: [] }));
    expect(await screen.findByTestId("client-review-empty")).toHaveTextContent(
      "No clips are ready to review yet.",
    );
    expect(screen.queryByTestId("client-decision-bar")).not.toBeInTheDocument();
  });

  it.each([
    [410, "review/link_revoked", "This review link was turned off by the people who sent it."],
    [410, "review/link_expired", "This review link has expired."],
    [404, "review/link_not_found", "This review link does not exist."],
  ])("explains a %s %s and does not offer a retry", async (status, code, message) => {
    render(
      new Response(JSON.stringify({ error: { code, message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await screen.findByTestId("client-review-gone")).toHaveTextContent(message);
    expect(screen.getByText("Ask the person who sent it for a new link.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("is laid out for a phone: one narrow column, and a bar of thumb-sized buttons fixed to the bottom", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: PHONE });
    window.dispatchEvent(new Event("resize"));
    render();
    const main = await screen.findByTestId("client-review");
    // One column, at most 28rem, with a 16 px gutter and room below for the bar.
    expect(main.className).toMatch(/\bmax-w-md\b/);
    expect(main.className).toMatch(/\bpx-4\b/);
    expect(main.className).toMatch(/\bpb-56\b/);
    const bar = screen.getByTestId("client-decision-bar");
    expect(bar.className).toMatch(/\bfixed\b/);
    expect(bar.className).toMatch(/\binset-x-0\b/);
    expect(bar.className).toMatch(/\bbottom-0\b/);
    expect(bar.className).toMatch(/safe-area-inset-bottom/);
    for (const button of [
      screen.getByTestId("client-approve"),
      screen.getByTestId("client-request-changes"),
    ]) {
      expect(button.className).toMatch(/\bh-12\b/);
    }
    // The video fills the column, tall and vertical.
    const video = screen.getByTestId(`client-video-${CLIP_A}`);
    expect(video).toHaveClass("aspect-[9/16]", "w-full");
    expect(video).toHaveAttribute("playsinline");
  });
});
