import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WhatWorksView } from "./what-works-view";

import type { WhatWorks } from "@/components/repurpose/performance/use-performance";


import { renderWithProviders } from "@/test/harness";

/**
 * `/repurpose/what-works` (2026-10-05): the best clips, what they share with
 * the number of posts behind every group, and what the next picks lean toward
 * - and nothing claimed from a handful.
 */
const ENTITLEMENT = "/workspaces/01JWORKSPACE/entitlement";
const WHAT_WORKS = "/repurpose/performance/what-works";
const ON = { repurpose_flow: true, repurpose_performance: true };

function entitlement(flags: Record<string, boolean>): Record<string, unknown> {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 200,
    seatsIncluded: 1,
    seatsUsed: 1,
    computedAt: "2026-10-05T10:00:00.000Z",
    entitlements: { flags },
  };
}

function report(overrides: Partial<WhatWorks> = {}): WhatWorks {
  return {
    enabled: true,
    days: 90,
    timeZone: "Asia/Kolkata",
    generatedAt: "2026-10-06T12:00:00.000Z",
    totals: { posts: 14, withViews: 12, measured: 9, entered: 3, clips: 6 },
    enough: true,
    thresholds: { minPosts: 5, minGroup: 5, clearLift: 1.25, steeringMinPosts: 8 },
    platforms: [
      { platform: "youtube", posts: 8, medianViews: 1_460 },
      { platform: "instagram", posts: 4, medianViews: 820 },
    ],
    topByViews: [
      {
        clipId: "01JWWCLIP00000000000000001",
        runId: "01JWWRUN000000000000000001",
        title: "Salary aate hi ye galti mat karna",
        views: 48_000,
        engagementRate: 0.06,
        bestRelative: 9.2,
        posts: [
          { postId: "p1", platform: "youtube", views: 40_000, url: null },
          { postId: "p2", platform: "instagram", views: 8_000, url: null },
        ],
      },
    ],
    topByEngagement: [],
    dimensions: [
      {
        key: "length",
        label: "Length",
        groups: [
          { key: "20-40", label: "20–40 s", posts: 7, medianRelative: 1.6, medianEngagement: 0.05 },
          {
            key: "over-60",
            label: "Over 60 s",
            posts: 5,
            medianRelative: 0.8,
            medianEngagement: null,
          },
        ],
        finding: {
          dimension: "length",
          key: "20-40",
          label: "20–40 s",
          lift: 2,
          posts: 7,
          restPosts: 5,
          sentence:
            "20–40 s clips got 2.0× the views of the rest, compared platform by platform (7 posts, against 5).",
        },
        note: null,
      },
      {
        key: "layout",
        label: "Layout",
        groups: [
          {
            key: "single",
            label: "One speaker",
            posts: 12,
            medianRelative: 1,
            medianEngagement: 0.04,
          },
        ],
        finding: null,
        note: "Every post so far falls in one group: nothing to compare yet.",
      },
    ],
    findings: [],
    steering: {
      basis: 12,
      lines: ["Moments like “Salary aate hi ye galti mat karna” (40,000 views on YouTube)."],
    },
    ...overrides,
  };
}

function render(flags: Record<string, boolean>, body: WhatWorks | Response = report()) {
  return renderWithProviders(<WhatWorksView />, {
    routes: { [ENTITLEMENT]: entitlement(flags), [WHAT_WORKS]: body },
  });
}

describe("<WhatWorksView />", () => {
  it("says it is not on yet, and asks nothing, while a flag is off", async () => {
    const { fetchMock } = render({ repurpose_flow: true });
    expect(await screen.findByTestId("what-works-off")).toHaveTextContent(
      "What works is not on for this workspace yet",
    );
    expect(
      fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === WHAT_WORKS),
    ).toBe(false);
  });

  it("shows the best clips, what they share with the posts behind it, and the steering", async () => {
    render(ON);
    expect(await screen.findByTestId("what-works-totals")).toHaveTextContent(
      "14 posts of 6 clips; 12 with views (9 measured, 3 entered).",
    );
    const top = screen.getByTestId("top-by-views");
    expect(within(top).getByText("Salary aate hi ye galti mat karna")).toHaveAttribute(
      "href",
      "/repurpose/01JWWRUN000000000000000001#clip-01JWWCLIP00000000000000001",
    );
    expect(top).toHaveTextContent("48k views");
    expect(top).toHaveTextContent("YouTube 40k · Instagram 8k");

    expect(screen.getByTestId("dimension-finding-length")).toHaveTextContent(
      "20–40 s clips got 2.0× the views of the rest",
    );
    const length = screen.getByTestId("dimension-length");
    expect(within(length).getAllByRole("row")).toHaveLength(3);
    expect(length).toHaveTextContent("1.6×");
    expect(screen.getByTestId("dimension-note-layout")).toHaveTextContent(
      "Every post so far falls in one group",
    );
    expect(screen.getByTestId("what-works-steering")).toHaveTextContent(
      "From 12 posts with views. A small nudge only",
    );
    expect(screen.getByTestId("usual-youtube")).toHaveTextContent("YouTube 1.5k views (8 posts)");
  });

  it("claims nothing from a handful, and says when the picks start leaning", async () => {
    render(ON, report({ enough: false, steering: null, topByViews: [], dimensions: [] }));
    expect(await screen.findByText("Not enough to go on yet")).toBeInTheDocument();
    expect(screen.queryByTestId("top-by-views")).toBeNull();
    expect(screen.getByTestId("what-works-steering")).toHaveTextContent(
      "Your next runs are picked as usual until 8 posts on at least 4 clips have views.",
    );
  });

  it("reads another window when asked", async () => {
    const { fetchMock } = render(ON);
    await screen.findByTestId("what-works-totals");
    fireEvent.click(screen.getByTestId("what-works-window-365"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(String(input));
          return url.pathname === WHAT_WORKS && url.searchParams.get("days") === "365";
        }),
      ).toBe(true);
    });
    expect(screen.getByTestId("what-works-window-365")).toHaveAttribute("aria-pressed", "true");
  });

  it("reads a 404 as off", async () => {
    render(
      ON,
      new Response(JSON.stringify({ error: { code: "performance/not_available", message: "x" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await screen.findByTestId("what-works-off")).toBeInTheDocument();
  });
});
