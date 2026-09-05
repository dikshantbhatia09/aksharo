import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { ExportDialog } from "./ExportDialog";
import { ExportHistory } from "./ExportHistory";

import { renderWithProviders } from "@/test/harness";

/**
 * The exports history (S-02 step 2, rewritten for S05).
 *
 * F-06's QA 7: close the dialog mid-render and the render finishes unobserved —
 * reopening shows no progress, no download, and an Export button inviting a
 * second one. These tests drive the real component against stubbed server
 * answers: the rows and their chips, a download presigned at click time and
 * never before, the poll that follows a live render, and — the part that costs
 * money — the poll actually stopping once nothing can change.
 *
 * S05 changed what "a live render" IS on this screen. S-02 had to read the jobs
 * list beside the exports list, because a cloud export had no row until it
 * finished; the row now exists from the POST as `rendering`, so every fixture
 * here is an `exports` row and the jobs endpoint is not called at all.
 */

const PROJECT_ID = "01JSPR0JECT000000000000000";
const MP4_ID = "01JSEXP0RTMP4000000000000A";
const SRT_ID = "01JSEXP0RTSRT000000000000B";
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

/** The S05 row a cloud export is from the moment it is requested. */
function renderingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return exportRow({
    status: "rendering",
    sizeBytes: null,
    durationMs: null,
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    ...overrides,
  });
}

function exportPage(...items: readonly Record<string, unknown>[]): Record<string, unknown> {
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

describe("<ExportHistory /> — the exports a project already has (S02-2, S05-5)", () => {
  it("lists each export with its kind and a status chip", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: exportPage(
          exportRow({ watermarked: true }),
          exportRow({
            id: SRT_ID,
            status: "failed",
            kind: "srt",
            preset: null,
            createdAt: new Date(Date.now() - 600_000).toISOString(),
          }),
        ),
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
    expect(rows[1]).toHaveTextContent("Render failed");
    expect(rows[1]).not.toHaveTextContent("Watermarked");
    // Nothing to fetch for a failed export.
    expect(within(rows[1] as HTMLElement).queryByTestId("export-history-download")).toBeNull();
  });

  /**
   * S05's headline: a render that fails is a row that says so. Before it, the
   * failure wrote nothing at all and the export simply vanished from the list.
   */
  it("shows a failed row in red, and offers nothing to download", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: { [EXPORTS_PATH]: exportPage(exportRow({ status: "failed" })) },
    });

    const row = await screen.findByTestId("export-history-row");
    expect(row).toHaveTextContent("Render failed");
    expect(within(row).queryByTestId("export-history-download")).toBeNull();
    // The rejected tone, not merely "not green" (`badgeVariants`, packages/ui).
    const chip = within(row).getByText("Render failed");
    expect(chip.className).toContain("text-rejected");
  });

  /** A cloud render in flight is amber; a browser export is its own neutral state. */
  it("distinguishes a cloud render in flight from a browser export", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: exportPage(
          renderingRow(),
          exportRow({
            id: SRT_ID,
            status: "pending_browser",
            createdAt: new Date(Date.now() - 600_000).toISOString(),
          }),
        ),
      },
    });

    const rows = await screen.findAllByTestId("export-history-row");
    expect(rows[0]).toHaveTextContent("Rendering…");
    expect(within(rows[0] as HTMLElement).getByText("Rendering…").className).toContain(
      "text-warning",
    );
    expect(within(rows[0] as HTMLElement).queryByTestId("export-history-download")).toBeNull();

    expect(rows[1]).toHaveTextContent("In browser");
    expect(within(rows[1] as HTMLElement).queryByTestId("export-history-download")).toBeNull();
  });

  it("says so plainly when the project has never exported anything", async () => {
    renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: { [EXPORTS_PATH]: exportPage() },
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
        [EXPORTS_PATH]: exportPage(exportRow()),
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
   * The reattach itself, and its off switch. Since S05 the running render IS a
   * row (`rendering`), so one endpoint carries the whole lifecycle; once every
   * row is terminal there is nothing left that can change without a click, and
   * the timer must not be armed again (QA 5: no traffic on an idle dialog).
   */
  it("follows a running render, then stops polling once nothing can change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: respondsInTurn(
          exportPage(renderingRow()),
          exportPage(renderingRow()),
          exportPage(exportRow()),
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
    expect(running).toHaveTextContent("MP4 · reels");
    expect(running).toHaveTextContent("Rendering…");

    // Tick 2, after the first 5 s backoff step: still rendering, read again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(2);
    expect(screen.getByTestId("export-history-row")).toHaveTextContent("Rendering…");

    // Tick 3, after the 10 s step: the row is terminal, so this is the last read.
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
    // And the jobs list this panel used to poll is gone for good (S05-5).
    expect(callsTo(fetchMock, JOBS_PATH)).toBe(0);
  });

  /** An all-terminal list must arm no timer at all — one tick and done. */
  it("never polls a second time when every row is already terminal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(<ExportHistory projectId={PROJECT_ID} />, {
      routes: {
        [EXPORTS_PATH]: exportPage(exportRow(), exportRow({ id: SRT_ID, status: "failed" })),
      },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callsTo(fetchMock, EXPORTS_PATH)).toBe(1);
    expect(callsTo(fetchMock, JOBS_PATH)).toBe(0);
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
      routes: { [EXPORTS_PATH]: exportPage(renderingRow()) },
    });

    await screen.findByTestId("export-history-row");
    // `findBy`, not `getBy`: the row reaches the screen one commit before the
    // dialog above learns from it (`onActiveChange` is a passive effect).
    expect(await screen.findByTestId("export-render-in-flight")).toHaveTextContent(
      "A render is already running — see Previous exports.",
    );
    // OC-02 found this sampling one commit early (~1 run in 6): `renderInFlight`
    // is set by a passive effect after the row paints, so wait for it.
    await waitFor(() => expect(screen.getByTestId("export-start")).toBeDisabled());
  });

  it("leaves Export enabled when every render has settled", async () => {
    renderWithProviders(dialog(), {
      routes: { [EXPORTS_PATH]: exportPage(exportRow()) },
    });

    await screen.findByTestId("export-history-row");
    expect(screen.getByTestId("export-start")).toBeEnabled();
    expect(screen.queryByTestId("export-render-in-flight")).toBeNull();
  });
});
