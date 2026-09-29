import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ClipReview } from "./ClipReview";

import type { ClipReviewDetail, ClipReviewSummary, ReviewPermissions } from "./use-review";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const CLIP = "01JS00000000000000000CL1PA";
const REVIEW_PATH = `/repurpose/runs/${RUN}/clips/${CLIP}/review`;
const COMMENTS_PATH = `/repurpose/runs/${RUN}/clips/${CLIP}/comments`;

const OWNER: ReviewPermissions = {
  approve: true,
  requestChanges: true,
  comment: true,
  resolveAny: true,
  shareLinks: true,
  revokeLinks: true,
};
const EDITOR: ReviewPermissions = { ...OWNER, approve: false, shareLinks: false };
const VIEWER: ReviewPermissions = {
  ...EDITOR,
  requestChanges: false,
  resolveAny: false,
  revokeLinks: false,
};

function summary(over: Partial<ClipReviewSummary> = {}): ClipReviewSummary {
  return {
    clipId: CLIP,
    state: "pending",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    covered: [],
    uncovered: [],
    videos: { "9:16": "EXP916" },
    video: {
      shape: "9:16",
      exportId: "EXP916",
      url: "https://media.test/v.mp4?X-Amz-Expires=3600",
      durationMs: 30_000,
    },
    comments: { total: 0, open: 0 },
    ...over,
  };
}

function detail(over: Partial<ClipReviewDetail> = {}): ClipReviewDetail {
  return { clip: summary(), events: [], comments: [], ...over };
}

function bodiesOf(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
  method: string,
): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(String(input)).pathname === path &&
        ((init as RequestInit | undefined)?.method ?? "GET") === method,
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
}

function render(
  props: Partial<React.ComponentProps<typeof ClipReview>> = {},
  routes: Record<string, unknown> = {},
) {
  return renderWithProviders(
    <ClipReview
      runId={RUN}
      clipId={CLIP}
      title="Why most people never save"
      review={summary()}
      permissions={OWNER}
      needsApproval={false}
      autopilot
      showVideo={false}
      {...props}
    />,
    { routes: { [REVIEW_PATH]: summary(), ...routes } },
  );
}

describe("<ClipReview />", () => {
  it("shows a waiting clip, and approves it pinned to the videos it showed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render({ needsApproval: true });
    const panel = screen.getByTestId(`clip-review-${CLIP}`);
    expect(panel).toHaveAttribute("data-state", "pending");
    expect(within(panel).getByTestId(`review-state-${CLIP}`)).toHaveTextContent(
      "Waiting for review",
    );
    expect(screen.getByTestId(`review-needs-approval-${CLIP}`)).toHaveTextContent(
      "Needs approval before it can be posted.",
    );
    await user.click(screen.getByRole("button", { name: "Approve: Why most people never save" }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, REVIEW_PATH, "POST")).toEqual([
        { decision: "approved", expect: { "9:16": "EXP916" } },
      ]);
    });
  });

  it("offers an editor only a request for changes, which carries what should change", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render({ permissions: EDITOR });
    expect(screen.queryByTestId(`review-approve-${CLIP}`)).not.toBeInTheDocument();
    await user.click(screen.getByTestId(`review-request-${CLIP}`));
    await user.type(screen.getByLabelText("What should change?"), "Cut the first two seconds");
    await user.click(screen.getByTestId(`review-request-send-${CLIP}`));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, REVIEW_PATH, "POST")).toEqual([
        {
          decision: "changes_requested",
          note: "Cut the first two seconds",
          expect: { "9:16": "EXP916" },
        },
      ]);
    });
  });

  it("lets a viewer comment, and nothing else", () => {
    render({ permissions: VIEWER });
    expect(screen.queryByTestId(`review-approve-${CLIP}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`review-request-${CLIP}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`review-comments-${CLIP}`)).toBeInTheDocument();
  });

  it("says who approved it, and offers to cover the shapes made after", async () => {
    const user = userEvent.setup();
    const { fetchMock } = render({
      review: summary({
        state: "approved",
        decidedBy: {
          kind: "client",
          name: "Priya",
          userId: null,
          link: { id: "L1", hint: "a7Bq", label: null },
        },
        decidedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        covered: ["9:16"],
        uncovered: ["1:1"],
        videos: { "9:16": "EXP916", "1:1": "EXP11" },
      }),
    });
    expect(screen.getByTestId(`review-state-${CLIP}`)).toHaveTextContent("Approved");
    expect(screen.getByTestId(`review-by-${CLIP}`)).toHaveTextContent(
      "Client: Priya · 5 minutes ago",
    );
    expect(screen.getByTestId(`review-uncovered-${CLIP}`)).toHaveTextContent(
      "The square (1:1) video was made after this approval.",
    );
    await user.click(screen.getByRole("button", { name: /Approve these too/ }));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, REVIEW_PATH, "POST")).toEqual([
        { decision: "approved", expect: { "9:16": "EXP916", "1:1": "EXP11" } },
      ]);
    });
  });

  it("offers no approval again once every video is covered", () => {
    render({ review: summary({ state: "approved", covered: ["9:16"] }) });
    expect(screen.queryByTestId(`review-approve-${CLIP}`)).not.toBeInTheDocument();
  });

  it("says a clip is back in review because its video changed", () => {
    render({
      review: summary({
        reason: "video_changed",
        decidedBy: { kind: "system", name: null, userId: null, link: null },
      }),
    });
    expect(screen.getByTestId(`review-reopened-${CLIP}`)).toHaveTextContent(
      "Back in review: its video changed after the last decision.",
    );
  });

  it("explains why a clip with no finished video cannot be approved yet", () => {
    render({ review: summary({ videos: {}, video: null }), autopilot: false });
    expect(screen.queryByTestId(`review-approve-${CLIP}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`review-no-video-${CLIP}`)).toHaveTextContent(
      /Export this clip from the editor/,
    );
  });

  it("plays the video under review itself when the card shows none", () => {
    render({ showVideo: true });
    expect(screen.getByTestId(`review-video-${CLIP}`)).toHaveAttribute(
      "src",
      "https://media.test/v.mp4?X-Amz-Expires=3600",
    );
  });

  it("shows the API's reason when a decision is refused", async () => {
    const user = userEvent.setup();
    render(
      {},
      {
        [REVIEW_PATH]: new Response(
          JSON.stringify({
            error: {
              code: "review/video_changed",
              message: "This clip's video changed while you were looking.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    );
    await user.click(screen.getByTestId(`review-approve-${CLIP}`));
    expect(await screen.findByTestId(`review-error-${CLIP}`)).toHaveTextContent(
      "This clip's video changed while you were looking.",
    );
  });

  it("opens the thread: comments with their moment, resolve, and a new comment at the playhead", async () => {
    const user = userEvent.setup();
    const seeks: number[] = [];
    const { fetchMock } = render(
      {
        review: summary({ comments: { total: 1, open: 1 } }),
        playheadMs: 12_400,
        onSeek: (ms) => seeks.push(ms),
      },
      {
        [REVIEW_PATH]: detail({
          comments: [
            {
              id: "C1",
              clipId: CLIP,
              author: { kind: "client", name: "Priya", userId: null, link: null },
              body: "The hook is too slow",
              atMs: 3_000,
              resolvedAt: null,
              createdAt: new Date().toISOString(),
              canResolve: true,
            },
          ],
          events: [
            {
              id: "E1",
              state: "changes_requested",
              actor: { kind: "client", name: "Priya", userId: null, link: null },
              note: "The hook is too slow",
              reason: null,
              shapes: ["9:16"],
              createdAt: new Date().toISOString(),
            },
          ],
        }),
        [COMMENTS_PATH]: {},
        [`${COMMENTS_PATH}/C1`]: {},
      },
    );
    await user.click(screen.getByRole("button", { name: "Comments (1)" }));
    const comment = await screen.findByTestId("clip-comment-C1");
    expect(comment).toHaveTextContent("Client: Priya");
    expect(comment).toHaveTextContent("The hook is too slow");
    await user.click(within(comment).getByRole("button", { name: "Play from 0:03" }));
    expect(seeks).toEqual([3_000]);
    await user.click(within(comment).getByTestId("clip-comment-resolve-C1"));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, `${COMMENTS_PATH}/C1`, "PATCH")).toEqual([{ resolved: true }]);
    });

    expect(screen.getByText("At 0:12 in the clip")).toBeInTheDocument();
    await user.type(screen.getByTestId(`review-comment-body-${CLIP}`), "Love the ending");
    await user.click(screen.getByTestId(`review-comment-post-${CLIP}`));
    await waitFor(() => {
      expect(bodiesOf(fetchMock, COMMENTS_PATH, "POST")).toEqual([
        { body: "Love the ending", atMs: 12_400 },
      ]);
    });
    expect(screen.getByTestId(`clip-history-${CLIP}`)).toHaveTextContent("Changes requested");
  });

  it("gives every action a thumb-sized target on a phone", () => {
    render({ permissions: OWNER });
    for (const id of [
      `review-approve-${CLIP}`,
      `review-request-${CLIP}`,
      `review-comments-${CLIP}`,
    ]) {
      expect(screen.getByTestId(id).className).toMatch(/\bh-11\b/);
      expect(screen.getByTestId(id).className).toMatch(/\bsm:h-8\b/);
    }
  });

  it("renders nothing until the review is known", () => {
    const { container } = render({ review: undefined });
    expect(container).toBeEmptyDOMElement();
  });
});
