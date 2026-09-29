import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  RepurposeCandidateItem,
  RepurposeClipFormat,
  RepurposeClipItem,
  RepurposeCompilationShape,
} from "@montaj/api-client";

import { CompilationBuilder, type BuilderMode } from "./CompilationBuilder";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JCRN0000000000000000000A";
const ROUTE = `/repurpose/runs/${RUN}/compilations`;
const SERIES_ROUTE = `/repurpose/runs/${RUN}/series`;

function format(shape: RepurposeClipFormat["shape"], durationMs: number): RepurposeClipFormat {
  return {
    shape,
    status: "ready",
    projectId: "01JCPR0JECT000000000000000",
    captioned: { status: "ready", playUrl: "https://x/p", downloadUrl: "https://x/d", durationMs },
    cleanUrl: null,
  };
}

const candidates: RepurposeCandidateItem[] = [
  { id: "c1", startMs: 60_000, endMs: 90_000, title: "The money bit", potentialScore: 91 },
  { id: "c2", startMs: 10_000, endMs: 40_000, title: "The opening", potentialScore: 70 },
  { id: "c3", startMs: 200_000, endMs: 230_000, title: "My own pick", potentialScore: null },
];

const clips: RepurposeClipItem[] = [
  {
    id: "k1",
    candidateId: "c1",
    state: "ready",
    sourceStartMs: 60_000,
    formats: [format("9:16", 28_000)],
  },
  {
    id: "k2",
    candidateId: "c2",
    state: "ready",
    sourceStartMs: 10_000,
    formats: [format("9:16", 31_000)],
  },
  {
    id: "k3",
    candidateId: "c3",
    state: "ready",
    sourceStartMs: 200_000,
    formats: [format("9:16", 25_000)],
  },
];

/** The builder with the run page's state around it. */
function Harness({
  initial = [],
  onClose = () => undefined,
  initialMode = "compilation",
}: {
  readonly initial?: string[];
  readonly onClose?: () => void;
  readonly initialMode?: BuilderMode;
}): React.JSX.Element {
  const [picked, setPicked] = React.useState<string[]>(initial);
  const [mode, setMode] = React.useState<BuilderMode>(initialMode);
  const [shape, setShape] = React.useState<RepurposeCompilationShape>("9:16");
  return (
    <>
      <CompilationBuilder
        runId={RUN}
        clips={clips}
        candidates={candidates}
        mode={mode}
        onModeChange={setMode}
        shape={shape}
        onShapeChange={setShape}
        picked={picked}
        onPickedChange={setPicked}
        onClose={onClose}
      />
      <output data-testid="picked">{picked.join(",")}</output>
    </>
  );
}

function made(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01JCC0MP11AT10N00000000000",
    runId: RUN,
    shape: "9:16",
    title: null,
    clipIds: ["k2", "k1"],
    status: "rendering",
    failureCode: null,
    durationMs: 58_500,
    progress: null,
    playUrl: null,
    downloadUrl: null,
    expiresAt: null,
    stale: false,
    canRetry: false,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "refused" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("<CompilationBuilder /> (2026-10-03)", () => {
  it("picks the best of the video, in the video's order, and says how long it runs", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByTestId("compilation-create")).toBeDisabled();
    fireEvent.click(screen.getByTestId("compilation-best-of"));
    expect(screen.getByTestId("picked")).toHaveTextContent("k2,k1");
    const order = screen.getByTestId("compilation-order");
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([expect.stringContaining("The opening"), expect.stringContaining("The money bit")]);
    // 31 s + 28 s, one half-second fade.
    expect(screen.getByTestId("compilation-summary")).toHaveTextContent("2 clips · 0:59");
    expect(screen.getByTestId("compilation-create")).toBeEnabled();
  });

  it("moves a clip up, down and out", () => {
    renderWithProviders(<Harness initial={["k2", "k1", "k3"]} />);
    fireEvent.click(screen.getByTestId("order-up-k3"));
    expect(screen.getByTestId("picked")).toHaveTextContent("k2,k3,k1");
    fireEvent.click(screen.getByTestId("order-down-k2"));
    expect(screen.getByTestId("picked")).toHaveTextContent("k3,k2,k1");
    fireEvent.click(screen.getByTestId("order-remove-k2"));
    expect(screen.getByTestId("picked")).toHaveTextContent("k3,k1");
    expect(screen.getByTestId("order-up-k3")).toBeDisabled();
    expect(screen.getByTestId("order-down-k1")).toBeDisabled();
  });

  it("makes the compilation in the order set, with its title card, and closes", async () => {
    const onClose = vi.fn();
    const { fetchMock } = renderWithProviders(
      <Harness initial={["k1", "k2"]} onClose={onClose} />,
      {
        routes: { [ROUTE]: made({ title: "Best of", clipIds: ["k1", "k2"] }) },
      },
    );
    fireEvent.change(screen.getByTestId("compilation-title"), { target: { value: " Best of " } });
    expect(screen.getByTestId("compilation-summary")).toHaveTextContent("2 clips · 1:00");
    fireEvent.click(screen.getByTestId("compilation-create"));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(ROUTE));
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      clipIds: ["k1", "k2"],
      shape: "9:16",
      title: "Best of",
    });
    expect(screen.getByTestId("picked")).toHaveTextContent("");
  });

  it("says why a compilation was refused, in the page's words", async () => {
    renderWithProviders(<Harness initial={["k1", "k2"]} />, {
      routes: { [ROUTE]: refused(409, "repurpose/compilation_clips_not_ready") },
    });
    fireEvent.click(screen.getByTestId("compilation-create"));
    expect(await screen.findByTestId("compilation-error")).toHaveTextContent(
      "no captioned video in this shape yet",
    );
  });

  it("numbers a series in the video's order and makes it", async () => {
    const { fetchMock } = renderWithProviders(
      <Harness initial={["k3", "k1", "k2"]} initialMode="series" />,
      {
        routes: {
          [SERIES_ROUTE]: {
            id: "01JCSER1ES0000000000000000",
            runId: RUN,
            clipIds: ["k2", "k1", "k3"],
            parts: [],
            createdAt: "2026-10-03T00:00:00.000Z",
          },
        },
      },
    );
    const order = screen.getByTestId("series-order");
    expect(
      within(order)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringMatching(/Part 1.*The opening/),
      expect.stringMatching(/Part 2.*The money bit/),
      expect.stringMatching(/Part 3.*My own pick/),
    ]);
    fireEvent.click(screen.getByTestId("series-create"));
    expect(await screen.findByTestId("series-made")).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(SERIES_ROUTE));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      clipIds: ["k2", "k1", "k3"],
    });
  });
});
