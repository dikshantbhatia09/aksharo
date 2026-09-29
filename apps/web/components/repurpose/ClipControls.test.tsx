import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { RepurposeCandidateItem, RepurposeClipItem } from "@montaj/api-client";

import { ClipControls, RemovedMoment } from "./ClipControls";

import { renderWithProviders } from "@/test/harness";

/**
 * A moment's own controls (steering, 2026-09-29): remove it, bring it back,
 * move its start and end and cut it again.
 */
const RUN_ID = "01JS0000000000000000000RUN";
const CAND = "01JS00000000000000000CANDA";
const MOMENT = `/repurpose/runs/${RUN_ID}/candidates/${CAND}`;
const PREVIEW = `/repurpose/runs/${RUN_ID}/preview`;

const candidate: RepurposeCandidateItem = {
  id: CAND,
  startMs: 60_000,
  endMs: 90_000,
  title: "The point lands",
  state: "proposed",
};
const clip: RepurposeClipItem = {
  id: "01JS00000000000000000CL1PA",
  candidateId: CAND,
  state: "ready",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function calls(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
): Array<{ method: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => {
      const request = init as RequestInit | undefined;
      return {
        method: request?.method ?? "GET",
        body: typeof request?.body === "string" ? (JSON.parse(request.body) as unknown) : null,
      };
    });
}

const ok = { candidate, clip: null, promoted: [] };

describe("<ClipControls />", () => {
  it("removes the moment and its clip in one press, without asking first", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={clip}
        clipState="ready"
        title="The point lands"
      />,
      { routes: { [`${MOMENT}/remove`]: ok } },
    );
    const remove = screen.getByRole("button", { name: "Remove this clip: The point lands" });
    await user.click(remove);
    await waitFor(() => {
      expect(calls(fetchMock, `${MOMENT}/remove`)).toEqual([{ method: "POST", body: null }]);
    });
  });

  it("says 'this moment' for a moment with no clip yet", () => {
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={undefined}
        clipState={undefined}
        title="The point lands"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Remove this moment: The point lands" }),
    ).toBeInTheDocument();
  });

  it("nudges the start and end, shows where they land, and re-cuts at those times", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={clip}
        clipState="ready"
        title="The point lands"
      />,
      {
        routes: {
          [MOMENT]: ok,
          [PREVIEW]: { runId: RUN_ID, projectId: "p", durationMs: 600_000, previewUrl: null },
        },
      },
    );
    await user.click(screen.getByTestId(`adjust-moment-${CAND}`));
    expect(screen.getByTestId(`adjust-start-${CAND}`)).toHaveTextContent("1:00");
    // Nothing changed yet: nothing to re-cut.
    expect(screen.getByTestId(`recut-moment-${CAND}`)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Start 5 seconds earlier" }));
    await user.click(screen.getByRole("button", { name: "End 1 second later" }));
    expect(screen.getByTestId(`adjust-start-${CAND}`)).toHaveTextContent("0:55");
    expect(screen.getByTestId(`adjust-end-${CAND}`)).toHaveTextContent("1:31");
    expect(screen.getByTestId(`adjust-length-${CAND}`)).toHaveTextContent("36 s long");

    await user.click(screen.getByTestId(`recut-moment-${CAND}`));
    await waitFor(() => {
      expect(calls(fetchMock, MOMENT)).toEqual([
        { method: "PATCH", body: { startMs: 55_000, endMs: 91_000 } },
      ]);
    });
    // Done: the nudges fold away.
    await waitFor(() => {
      expect(screen.queryByTestId(`adjust-panel-${CAND}`)).toBeNull();
    });
  });

  it("only saves the times of a moment that has no clip", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={undefined}
        clipState={undefined}
        title="The point lands"
      />,
    );
    await user.click(screen.getByTestId(`adjust-moment-${CAND}`));
    expect(screen.getByTestId(`recut-moment-${CAND}`)).toHaveTextContent("Save times");
  });

  it("never lets a nudge make a moment under 3 seconds", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={{ ...candidate, endMs: 63_000 }}
        clip={clip}
        clipState="ready"
        title="The point lands"
      />,
    );
    await user.click(screen.getByTestId(`adjust-moment-${CAND}`));
    expect(screen.getByRole("button", { name: "End 1 second earlier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start 1 second later" })).toBeDisabled();
  });

  it("says a refusal in plain words, never the server's own", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={clip}
        clipState="ready"
        title="The point lands"
      />,
      {
        routes: {
          [MOMENT]: json(409, {
            error: {
              code: "repurpose/clip_bounds_taken",
              message: "unique (run_id, start_ms, end_ms)",
            },
          }),
        },
      },
    );
    await user.click(screen.getByTestId(`adjust-moment-${CAND}`));
    await user.click(screen.getByRole("button", { name: "End 5 seconds later" }));
    await user.click(screen.getByTestId(`recut-moment-${CAND}`));
    expect(await screen.findByTestId(`steer-error-${CAND}`)).toHaveTextContent(
      "Another moment already has these times.",
    );
    expect(screen.queryByText(/unique/)).toBeNull();
  });

  it("waits for a clip being cut before its times can change", () => {
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={clip}
        clipState="cutting"
        title="The point lands"
      />,
    );
    expect(screen.getByTestId(`adjust-moment-${CAND}`)).toBeDisabled();
    expect(screen.getByTestId(`adjust-wait-${CAND}`)).toHaveTextContent(
      "You can change the times once this clip is cut.",
    );
  });

  it("offers no new times on a stopped run, but still lets a moment go", () => {
    renderWithProviders(
      <ClipControls
        runId={RUN_ID}
        candidate={candidate}
        clip={clip}
        clipState="ready"
        title="The point lands"
        runStopped
      />,
    );
    expect(screen.queryByTestId(`adjust-moment-${CAND}`)).toBeNull();
    expect(screen.getByTestId(`remove-moment-${CAND}`)).toBeEnabled();
  });
});

describe("<RemovedMoment />", () => {
  it("folds to one line and brings the moment back", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ul>
        <RemovedMoment
          runId={RUN_ID}
          candidate={{ ...candidate, state: "rejected" }}
          title="The point lands"
        />
      </ul>,
      { routes: { [`${MOMENT}/restore`]: ok } },
    );
    expect(screen.getByTestId(`candidate-card-${CAND}`)).toHaveAttribute("data-removed", "true");
    expect(screen.getByText("Removed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restore: The point lands" }));
    await waitFor(() => {
      expect(calls(fetchMock, `${MOMENT}/restore`)).toEqual([{ method: "POST", body: null }]);
    });
  });
});
