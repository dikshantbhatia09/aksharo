import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { RepurposeClipItem } from "@montaj/api-client";

import { ClipLayoutControl } from "./ClipLayoutControl";
import { beginnerSafetyViolations, LAYOUT_COPY, REFUSAL_COPY } from "./copy";

import { renderWithProviders } from "@/test/harness";

/**
 * A clip's layout (two-speaker layouts, 2026-10-01): Auto, One speaker, or
 * Both speakers stacked one above the other.
 */
const RUN_ID = "01JS0000000000000000000RUN";
const CAND = "01JS00000000000000000CANDA";
const CLIP_ID = "01JS00000000000000000CL1PA";
const LAYOUT = `/repurpose/runs/${RUN_ID}/clips/${CLIP_ID}/layout`;

function clipOf(extra: Record<string, unknown> = {}, pictureLayout?: string): RepurposeClipItem {
  return {
    id: CLIP_ID,
    candidateId: CAND,
    state: "ready",
    variants: [
      {
        id: "01JS00000000000000000VAR1A",
        projectId: "01JS00000000000000000PR01A",
        aspect: "r9x16",
        ...(pictureLayout === undefined ? {} : { layout: pictureLayout }),
      },
    ],
    ...extra,
  };
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

const button = (name: "Auto" | "One speaker" | "Both speakers") =>
  screen.getByRole("button", { name });

describe("<ClipLayoutControl />", () => {
  it("starts a clip from before layouts on Auto, and says nothing more", () => {
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf()}
        clipState="ready"
        title="The point lands"
      />,
    );
    expect(screen.getByRole("group", { name: "Layout: The point lands" })).toBeInTheDocument();
    expect(button("Auto")).toHaveAttribute("aria-pressed", "true");
    expect(button("One speaker")).toHaveAttribute("aria-pressed", "false");
    expect(button("Both speakers")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId(`clip-layout-note-${CAND}`)).toBeNull();
  });

  it("asks for both speakers in one press", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf()}
        clipState="ready"
        title="The point lands"
      />,
      {
        routes: {
          [LAYOUT]: {
            clipId: CLIP_ID,
            layout: "stacked",
            applied: "stacked",
            recut: true,
            clip: null,
          },
        },
      },
    );
    await user.click(button("Both speakers"));
    await waitFor(() => {
      expect(calls(fetchMock, LAYOUT)).toEqual([{ method: "PUT", body: { layout: "stacked" } }]);
    });
    // Answered: shown as chosen while the list is read back, not back to Auto.
    await waitFor(() => {
      expect(button("Both speakers")).toHaveAttribute("aria-pressed", "true");
    });
    expect(button("Auto")).toHaveAttribute("aria-pressed", "false");
  });

  it("sends nothing for the layout the clip already has", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf({ layout: "single" })}
        clipState="ready"
        title="The point lands"
      />,
    );
    expect(button("One speaker")).toHaveAttribute("aria-pressed", "true");
    await user.click(button("One speaker"));
    expect(calls(fetchMock, LAYOUT)).toEqual([]);
  });

  it("says when Auto has put two people one above the other", () => {
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf({}, "stacked")}
        clipState="ready"
        title="The point lands"
      />,
    );
    expect(screen.getByTestId(`clip-layout-note-${CAND}`)).toHaveTextContent(
      LAYOUT_COPY.autoStacked,
    );
  });

  it("says why Both speakers still shows one person", () => {
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf({ layout: "stacked" }, "single")}
        clipState="ready"
        title="The point lands"
      />,
    );
    expect(button("Both speakers")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId(`clip-layout-note-${CAND}`)).toHaveTextContent(LAYOUT_COPY.onlyOne);
  });

  it("waits while the clip is being cut, and says nothing of a picture not made yet", () => {
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf({ layout: "stacked" }, "single")}
        clipState="cutting"
        title="The point lands"
      />,
    );
    for (const name of ["Auto", "One speaker", "Both speakers"] as const) {
      expect(button(name)).toBeDisabled();
    }
    expect(screen.queryByTestId(`clip-layout-note-${CAND}`)).toBeNull();
  });

  it("says a refusal in plain words", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf()}
        clipState="ready"
        title="The point lands"
      />,
      {
        routes: {
          [LAYOUT]: new Response(
            JSON.stringify({
              error: { code: "repurpose/clip_busy", message: "a job is running" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        },
      },
    );
    await user.click(button("One speaker"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      REFUSAL_COPY.layout["repurpose/clip_busy"],
    );
  });

  it("shows nothing before the moment has a clip, or on a stopped run", () => {
    const before = renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={undefined}
        clipState={undefined}
        title="The point lands"
      />,
    );
    expect(before.container).toBeEmptyDOMElement();
    before.unmount();
    renderWithProviders(
      <ClipLayoutControl
        runId={RUN_ID}
        candidateId={CAND}
        clip={clipOf()}
        clipState="ready"
        title="The point lands"
        runStopped
      />,
    );
    expect(screen.queryByTestId(`clip-layout-${CAND}`)).toBeNull();
  });

  it("keeps its words free of anything technical", () => {
    const words = [
      LAYOUT_COPY.legend,
      LAYOUT_COPY.groupLabel("x"),
      ...Object.values(LAYOUT_COPY.choice),
      LAYOUT_COPY.autoStacked,
      LAYOUT_COPY.onlyOne,
      ...Object.values(REFUSAL_COPY.layout),
    ];
    for (const text of words) expect(beginnerSafetyViolations(text), text).toEqual([]);
  });
});
