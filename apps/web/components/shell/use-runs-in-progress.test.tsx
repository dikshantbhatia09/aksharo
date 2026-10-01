import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NavRail } from "./nav-rail";
import { inProgressLabel } from "./use-runs-in-progress";

import { renderWithProviders } from "@/test/harness";

const ENTITLEMENT = {
  workspaceId: "01JWORKSPACE",
  planKey: "free",
  planName: "Free",
  creditsPerMonthTenths: 2_000,
  seatsIncluded: 1,
  seatsUsed: 1,
  entitlements: { flags: { repurpose_flow: true } },
  computedAt: "2027-01-01T00:00:00.000Z",
};

function run(id: string, status: string): Record<string, unknown> {
  return { id, status, stages: [], currentStage: "transcribe", sourceKind: "youtube_url" };
}

describe("the Clips entry's work in progress", () => {
  it("counts the videos the server is making clips from, not ones waiting on the person", async () => {
    renderWithProviders(<NavRail />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": ENTITLEMENT,
        "/repurpose/runs": {
          items: [
            run("R1", "transcribing"),
            run("R2", "rendering"),
            run("R3", "candidates_ready"),
            run("R4", "draft"),
            run("R5", "failed"),
          ],
          nextCursor: null,
        },
      },
    });
    const badge = await screen.findByTestId("nav-repurpose-in-progress");
    expect(badge).toHaveTextContent("2");
    expect(
      within(screen.getByTestId("nav-repurpose")).getByText(", 2 videos in progress"),
    ).toBeInTheDocument();
  });

  it("shows nothing while nothing is moving", async () => {
    const { fetchMock } = renderWithProviders(<NavRail />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": ENTITLEMENT,
        "/repurpose/runs": { items: [run("R5", "failed")], nextCursor: null },
      },
    });
    await screen.findByTestId("nav-repurpose");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/repurpose/runs"))).toBe(
      true,
    );
    expect(screen.queryByTestId("nav-repurpose-in-progress")).not.toBeInTheDocument();
  });

  it("says it in words", () => {
    expect(inProgressLabel(1)).toBe("1 video in progress");
    expect(inProgressLabel(3)).toBe("3 videos in progress");
  });
});
