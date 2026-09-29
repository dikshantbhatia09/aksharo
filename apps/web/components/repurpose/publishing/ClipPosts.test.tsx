import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ClipPosts } from "./ClipPosts";

import type { PublishPost, PublishingStatus } from "./use-publishing";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const CLIP = "01JS00000000000000000CL1PA";

const ON: PublishingStatus = {
  enabled: true,
  available: true,
  reason: null,
  message: null,
  postizUrl: "http://localhost:4007",
  channelCount: 2,
};

function post(over: Partial<PublishPost>): PublishPost {
  return {
    id: "01JS000000000000000000P0ST",
    clipId: CLIP,
    runId: RUN,
    channel: { id: "01JS0000000000000000CHANIG", name: "Crest Mond", avatarUrl: null },
    provider: "instagram",
    platform: "Instagram",
    shape: "9:16",
    status: "posting",
    state: "processing",
    scheduledAt: null,
    publishedAt: null,
    url: null,
    title: null,
    text: "hello",
    error: null,
    note: null,
    canRetry: false,
    canCancel: false,
    createdAt: "2026-10-01T06:00:00.000Z",
    ...over,
  };
}

function calls(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
): string[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET");
}

describe("<ClipPosts />", () => {
  it("shows nothing at all while posting is switched off", async () => {
    const { container, fetchMock } = renderWithProviders(
      <ClipPosts runId={RUN} clipId={CLIP} title="A moment" ready />,
      {
        routes: {
          "/publishing/status": { ...ON, enabled: false, available: false, reason: "flag_off" },
        },
      },
    );
    await waitFor(() => {
      expect(calls(fetchMock, "/publishing/status")).toHaveLength(1);
    });
    expect(container).toBeEmptyDOMElement();
    // No posts are asked for either.
    expect(calls(fetchMock, `/repurpose/runs/${RUN}/posts`)).toEqual([]);
  });

  it("offers Post on a ready clip, and lists this clip's posts - not another clip's", async () => {
    renderWithProviders(<ClipPosts runId={RUN} clipId={CLIP} title="A moment" ready />, {
      routes: {
        "/publishing/status": ON,
        [`/repurpose/runs/${RUN}/posts`]: {
          posts: [
            post({
              id: "01JS00000000000000000POST1",
              status: "posted",
              state: "published",
              url: "https://www.instagram.com/reel/abc/",
              publishedAt: "2026-10-01T06:10:00.000Z",
            }),
            post({
              id: "01JS00000000000000000POST2",
              provider: "youtube",
              platform: "YouTube",
              status: "scheduled",
              state: "scheduled",
              scheduledAt: "2026-10-02T13:30:00.000Z",
              canCancel: true,
            }),
            post({ id: "01JS00000000000000000POST3", clipId: "01JS00000000000000000CL1PB" }),
          ],
        },
      },
    });
    expect(await screen.findByRole("button", { name: "Post: A moment" })).toBeInTheDocument();
    const posted = await screen.findByTestId("post-01JS00000000000000000POST1");
    expect(posted).toHaveAttribute("data-status", "posted");
    expect(within(posted).getByRole("link", { name: "View post on Instagram" })).toHaveAttribute(
      "href",
      "https://www.instagram.com/reel/abc/",
    );
    const scheduled = screen.getByTestId("post-01JS00000000000000000POST2");
    expect(scheduled).toHaveTextContent(/Scheduled for/);
    expect(within(scheduled).getByRole("button", { name: /Cancel post/ })).toBeInTheDocument();
    expect(screen.queryByTestId("post-01JS00000000000000000POST3")).not.toBeInTheDocument();
  });

  it("says why a post failed and tries it again", async () => {
    const user = userEvent.setup();
    const failed = post({
      status: "failed",
      state: "failed_retryable",
      error: { code: "publishing/provider_unavailable", message: "The account is paused." },
      canRetry: true,
      canCancel: true,
    });
    const { fetchMock } = renderWithProviders(
      <ClipPosts runId={RUN} clipId={CLIP} title="A moment" ready />,
      {
        routes: {
          "/publishing/status": ON,
          [`/repurpose/runs/${RUN}/posts`]: { posts: [failed] },
          [`/publishing/posts/${failed.id}/retry`]: { ...failed, status: "posting" },
        },
      },
    );
    const row = await screen.findByTestId(`post-${failed.id}`);
    expect(row).toHaveTextContent("Did not post. The account is paused.");
    await user.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(calls(fetchMock, `/publishing/posts/${failed.id}/retry`)).toEqual(["POST"]);
    });
  });

  it("asks before cancelling a scheduled post, then cancels it", async () => {
    const user = userEvent.setup();
    const scheduled = post({
      status: "scheduled",
      state: "scheduled",
      scheduledAt: "2026-10-02T13:30:00.000Z",
      canCancel: true,
    });
    const { fetchMock } = renderWithProviders(
      <ClipPosts runId={RUN} clipId={CLIP} title="A moment" ready />,
      {
        routes: {
          "/publishing/status": ON,
          [`/repurpose/runs/${RUN}/posts`]: { posts: [scheduled] },
          [`/publishing/posts/${scheduled.id}`]: { ...scheduled, status: "cancelled" },
        },
      },
    );
    await user.click(await screen.findByRole("button", { name: /Cancel post: Instagram/ }));
    expect(calls(fetchMock, `/publishing/posts/${scheduled.id}`)).toEqual([]);
    await user.click(await screen.findByTestId(`post-cancel-confirm-${scheduled.id}`));
    await waitFor(() => {
      expect(calls(fetchMock, `/publishing/posts/${scheduled.id}`)).toEqual(["DELETE"]);
    });
  });

  it("offers no Post button on a clip that is not ready", async () => {
    renderWithProviders(<ClipPosts runId={RUN} clipId={CLIP} title="A moment" ready={false} />, {
      routes: { "/publishing/status": ON, [`/repurpose/runs/${RUN}/posts`]: { posts: [] } },
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Post: A moment" })).not.toBeInTheDocument();
    });
  });
});
