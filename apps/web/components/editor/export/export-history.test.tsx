import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { ExportDialog } from "./ExportDialog";
import { ExportHistory } from "./ExportHistory";

import { renderWithProviders } from "@/test/harness";

/**
 * The exports history (S-02 step 2).
 *
 * F-06's QA 7: close the dialog mid-render and the render finishes unobserved —
 * reopening shows no progress, no download, and an Export button inviting a
 * second one. These tests drive the real component against stubbed server
 * answers: the rows and their chips, a download presigned at click time and
 * never before, the poll that follows a live render, and — the part that costs
 * money — the poll actually stopping once nothing can change.
 */

const PROJECT_ID = "01JSPR0JECT000000000000000";
const MP4_ID = "01JSEXP0RTMP4000000000000A";
const SRT_ID = "01JSEXP0RTSRT000000000000B";
const JOB_ID = "01JSJ0B0000000000000000001";
const DOWNLOAD_URL = "https://derived.test/exports/output.mp4?sig=abc";

const EXPORTS_PATH = "/projects/" + PROJECT_ID + "/exports";
const JOBS_PATH = "/jobs";

/**
 * The shared harness maps a path to ONE body and re-serialises it per call, so
 * a poll that must answer differently the second time needs the body itself to
 * change between serialisations. Same `toJSON` trick, and same reason, as
 * `export-dialog.cloud.test.tsx`.
 */
function respondsInTurn<T>(...bodies: readonly T[]): { toJSON: () => T } {
  let index = 0;
  return {
    toJSON: () => {
      const body = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return body as T;
    },
  };
}

/** `ExportDto` — `apps/api/src/exports/exports.dto.ts:199-212`. */
function exportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MP4_ID,
    projectId: PROJECT_ID,
    status: "succeeded",
    kind: "mp4",
    preset: "reels",
    watermarked: false,
    resolution: "1080x1920",
    durationMs: 30_000,
    sizeBytes: "10485760",
    expiresAt: null,
    downloads: 0,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

/** `JobSummary` — `packages/api-client/src/types.ts:478-497`. */
function renderJob(
  status: string,
  progress: number,
  type = "render.video",
): Record<string, unknown> {
  return {
    id: JOB_ID,
    type,
    status,
    priority: 100,
    progress,
    etaMs: null,
    projectId: PROJECT_ID,
    jobKey: type + ":" + PROJECT_ID + ":m1",
    attemptId: null,
    creditsChargedTenths: 0,
    maxQueueWaitMs: null,
    result: null,
    error: null,
    provider: null,
    model: null,
    queuedAt: new Date(Date.now() - 30_000).toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

function jobPage(...items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { items, nextCursor: null };
}

type FetchMock = ReturnType<typeof renderWithProviders>["fetchMock"];

/** How many times a path was actually fetched. */
function callsTo(fetchMock: FetchMock, pathname: string): number {
  return fetchMock.mock.calls.filter((call) => {
    const [input] = call as [unknown];
    return new URL(String(input)).pathname === pathname;
  }).length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<ExportHistory /> — the exports a project already has (S02-2)", () => {
  it("lists each export with its kind and a status chip", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: {
          items: [
            exportRow({ watermarked: true }),
            exportRow({
              id: SRT_ID,
              status: "failed",
              kind: "srt",
              preset: null,
              createdAt: new Date(Date.now() - 600_000).toISOString(),
            }),
          ],
          nextCursor: null,
        },
        [JOBS_PATH]: jobPage(),
      },
    });

    const rows = await screen.findAllByTestId("export-history-row");
    expect(rows).toHaveLength(2);

    // Newest first.
    expect(rows[0]).toHaveTextContent("MP4 · reels");
    expect(rows[0]).toHaveTextContent("Succeeded");
    expect(rows[0]).toHaveTextContent("Watermarked");
    expect(within(rows[0] as HTMLElement).getByTestId("export-history-download")).toHaveTextContent(
      "Download",
    );

    // A subtitle export is labelled by its kind, not as a video (QA 4).
    expect(rows[1]).toHaveTextContent("SRT");
    expect(rows[1]).toHaveTextContent("Failed");
    expect(rows[1]).not.toHaveTextContent("Watermarked");
    // Nothing to fetch for a failed export.
    expect(within(rows[1] as HTMLElement).queryByTestId("export-history-download")).toBeNull();
  });

  it("says so plainly when the project has never exported anything", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: { [EXPORTS_PATH]: { items: [], nextCursor: null }, [JOBS_PATH]: jobPage() },
    });

    expect(await screen.findByText("No exports yet.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("export-history-row")).toHaveLength(0);
  });

  /**
   * The presign is short-lived, so a URL fetched to fill in a list is a URL
   * that has expired by the time anyone clicks it — and a live credential
   * sitting in the DOM for every export the project ever made. It is fetched on
   * the click, once, for that row's id.
   */
  it("presigns the download on the click, never before, and opens the URL it gets", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    const { fetchMock } = renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: { items: [exportRow()], nextCursor: null },
        [JOBS_PATH]: jobPage(),
        ["/exports/" + MP4_ID + "/download"]: {
          url: DOWNLOAD_URL,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      },
    });

    const button = await screen.findByTestId("export-history-download");
    // The list is on screen and no download URL has been asked for.
    expect(callsTo(fetchMock, "/exports/" + MP4_ID + "/download")).toBe(0);

    await act(async () => {
      fireEvent.click(button);
    });

    expect(callsTo(fetchMock, "/exports/" + MP4_ID + "/download")).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(DOWNLOAD_URL, "_blank", "noreferrer");
  });

  /**
   * The reattach itself, and its off switch. A cloud export has no `exports`
   * row until it finishes (`schema.prisma:1913-1916`), so the running render
   * comes from the job it is made of; once that job is terminal there is
   * nothing left that can change without a click, and the timer must not be
   * armed again (QA 5: no traffic on an idle dialog).
   */
  it("follows a running render, then stops polling once nothing can change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: respondsInTurn(
          { items: [], nextCursor: null },
          { items: [], nextCursor: null },
          { items: [exportRow()], nextCursor: null },
        ),
        [JOBS_PATH]: respondsInTurn(
          jobPage(renderJob("running", 42)),
          jobPage(renderJob("running", 80)),
          jobPage(renderJob("succeeded", 100)),
        ),
      },
    });

    // Tick 1 rides the mount. `findBy*` polls through `waitFor`, which never
    // resolves against a faked clock — every wait in this case is an explicit
    // advance instead, which is also what makes the last assertion mean
    // something.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(1);
    const running = screen.getByTestId("export-history-row");
    expect(running).toHaveTextContent("Video · cloud render");
    expect(running).toHaveTextContent("Running — 42%");

    // Tick 2, after the first 5 s backoff step: the list is read again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(2);
    expect(screen.getByTestId("export-history-row")).toHaveTextContent("Running — 80%");

    // Tick 3, after the 10 s step: the job is terminal and the export row has
    // landed, so this is the last read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(3);
    expect(screen.getByTestId("export-history-row")).toHaveTextContent("Succeeded");

    // Idle: nothing non-terminal is left, so no further request is ever made.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(3);
    expect(callsTo(fetchMock, JOBS_PATH)).toBe(3);
  });
});

function dialog(): React.JSX.Element {
  return (
    <ExportDialog
      open
      onOpenChange={() => undefined}
      projectId={PROJECT_ID}
      projection={{} as EdgProjection}
      catalogue={new Map()}
      registry={{} as FontRegistry}
      shaper={{} as Shaper}
    />
  );
}

/**
 * F-06 closed the "cloud-offered was a dead end" half; this closes the invoice
 * it left open. Reopening the dialog over a render that is still going used to
 * offer a perfectly enabled Export button — one more render, one more credit
 * hold, for a file already being made.
 */
describe("<ExportDialog /> — a render already in flight (S02-2, addendum 3)", () => {
  it("disables Export and says why while the project has a running render", async () => {
    renderWithProviders(dialog(), {
      routes: {
        [EXPORTS_PATH]: { items: [], nextCursor: null },
        [JOBS_PATH]: jobPage(renderJob("running", 42)),
      },
    });

    await screen.findByTestId("export-history-row");
    expect(screen.getByTestId("export-start")).toBeDisabled();
    expect(screen.getByTestId("export-render-in-flight")).toHaveTextContent(
      "A render is already running — see Previous exports.",
    );
  });

  it("leaves Export enabled when every render has settled", async () => {
    renderWithProviders(dialog(), {
      routes: {
        [EXPORTS_PATH]: { items: [exportRow()], nextCursor: null },
        [JOBS_PATH]: jobPage(renderJob("succeeded", 100)),
      },
    });

    await screen.findByTestId("export-history-row");
    expect(screen.getByTestId("export-start")).toBeEnabled();
    expect(screen.queryByTestId("export-render-in-flight")).toBeNull();
  });
});
