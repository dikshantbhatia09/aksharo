import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { ExportDialog } from "./ExportDialog";

import { renderWithProviders } from "@/test/harness";

/**
 * The cloud half of the export journey (FIX-06).
 *
 * The audit found `cloud-offered` was a terminal phase: the server had already
 * enqueued the render, the dialog showed a yellow dead end, and four finished
 * MP4s sat on disk with `downloads = 0`. These tests drive the whole path the
 * way a reader does — click Export, watch the job, click Download — through the
 * real components and the real API client, with only the server's answers
 * stubbed. The counting assertion at the end is the audit's other finding: one
 * click must create exactly one export.
 */

const PROJECT_ID = "01JCPR0JECT000000000000000";
const EXPORT_ID = "01JCEXP0RT000000000000000A";
const JOB_ID = "01JCJ0B00000000000000000A1";
const DOWNLOAD_URL = "https://derived.test/exports/output.mp4?sig=abc";

/**
 * The shared harness maps a path to ONE body and re-serialises it on every
 * call, so a poll that must answer differently the second time needs the body
 * itself to change between serialisations. `toJSON` is the standard hook for
 * exactly that, and keeps this file from reaching into `@/test/harness`.
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

function job(status: string, progress: number): Record<string, unknown> {
  return {
    id: JOB_ID,
    type: "render.video",
    status,
    priority: 100,
    progress,
    etaMs: null,
    projectId: PROJECT_ID,
    jobKey: `render.video:${PROJECT_ID}:m1`,
    attemptId: null,
    creditsChargedTenths: 0,
    maxQueueWaitMs: null,
    result: null,
    error: null,
    provider: null,
    model: null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

/** `manifest` absent ⇒ the cloud path; `job` present ⇒ the server already enqueued it. */
function cloudExportResponse(watermarked = false): Record<string, unknown> {
  return {
    exportId: EXPORT_ID,
    path: "cloud",
    reasons: ["This browser has no hardware video encoder.", "2160p renders in the cloud."],
    watermarked,
    quote: { tenths: 12, credits: "1.2" },
    job: { jobId: JOB_ID, status: "queued", deduplicated: false },
  };
}

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

type FetchMock = ReturnType<typeof renderWithProviders>["fetchMock"];

/** How many exports this click actually created. */
function exportsCreated(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter((call) => {
    const [url, init] = call as [unknown, RequestInit | undefined];
    return String(url).endsWith(`/projects/${PROJECT_ID}/exports`) && init?.method === "POST";
  }).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("<ExportDialog /> — the cloud render is followed to a file (F06-4)", () => {
  it("shows progress while the job runs, then a download button with the resolved URL", async () => {
    // Only the two timer functions `sleep` uses, so React, Radix and the query
    // client keep their real clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(dialog(), {
      routes: {
        [`/projects/${PROJECT_ID}/exports`]: cloudExportResponse(),
        [`/jobs/${JOB_ID}`]: respondsInTurn(
          job("queued", 0),
          job("running", 42),
          job("succeeded", 100),
        ),
        [`/exports/${EXPORT_ID}/download`]: {
          url: DOWNLOAD_URL,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      },
    });

    // Poll 1 rides the click: the follower asks before it ever sleeps.
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-start"));
    });
    const progress = screen.getByTestId("export-cloud-progress");
    expect(progress).toHaveTextContent("Rendering in the cloud…");
    expect(progress).toHaveTextContent("Waiting for a render worker…");
    // The dead end is gone: no yellow offer panel while a job is being followed.
    expect(screen.queryByTestId("export-cloud-offer")).toBeNull();

    // Poll 2, after the first 2 s backoff step.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("export-cloud-progress")).toHaveTextContent("42%");

    // Poll 3, after the second (3 s) step — succeeded, so the URL is resolved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    const download = screen.getByTestId("export-download");
    expect(download).toHaveTextContent("Download file");
    expect(download.querySelector("a") ?? download).toHaveAttribute("href", DOWNLOAD_URL);
    expect(screen.getByTestId("export-cloud-download")).toHaveTextContent("Your export is ready.");

    // The whole journey, one export.
    expect(exportsCreated(fetchMock)).toBe(1);
  });

  it("says so honestly when the render finished but no link came back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    renderWithProviders(dialog(), {
      routes: {
        [`/projects/${PROJECT_ID}/exports`]: cloudExportResponse(),
        [`/jobs/${JOB_ID}`]: job("succeeded", 100),
        // `/exports/{id}/download` deliberately unstubbed — the harness 404s it.
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-start"));
    });

    const panel = screen.getByTestId("export-cloud-download");
    expect(panel).toHaveTextContent("no download link came back");
    expect(screen.queryByTestId("export-download")).toBeNull();
  });

  /**
   * A cloud render is server-owned: closing the dialog's eyes is not cancelling
   * it. Cancel has to reach `POST /jobs/{id}/cancel`, and the dialog has to say
   * so — the browser path gets `cancelled` from the engine's own throw, this
   * path has no throw to catch.
   */
  it("cancels the server job and says so, instead of sitting on the progress panel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(dialog(), {
      routes: {
        [`/projects/${PROJECT_ID}/exports`]: cloudExportResponse(),
        // Never settles on its own: only Cancel can end this render.
        [`/jobs/${JOB_ID}`]: job("running", 10),
        [`/jobs/${JOB_ID}/cancel`]: job("cancelled", 10),
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-start"));
    });
    expect(screen.getByTestId("export-cloud-progress")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-cancel"));
    });

    expect(screen.getByTestId("export-cancelled")).toHaveTextContent("Export cancelled.");
    expect(screen.queryByTestId("export-cloud-progress")).toBeNull();
    const cancelCalls = fetchMock.mock.calls.filter((call) => {
      const [url, init] = call as [unknown, RequestInit | undefined];
      return String(url).endsWith(`/jobs/${JOB_ID}/cancel`) && init?.method === "POST";
    });
    expect(cancelCalls).toHaveLength(1);

    // The poll in flight when Cancel landed must not resurrect the render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId("export-cancelled")).toBeInTheDocument();
    expect(screen.queryByTestId("export-cloud-download")).toBeNull();
  });

  /**
   * The audit's most expensive finding, end to end through the real tree: the
   * upsell panel's eligibility effect used to reach the same action as the
   * submit handler, so one click bought two renders and two credit holds — and
   * the second copy still came back watermarked.
   */
  it("does not start a second export when the watermark upsell reports a clean path", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { fetchMock } = renderWithProviders(dialog(), {
      routes: {
        [`/projects/${PROJECT_ID}/exports`]: cloudExportResponse(true),
        [`/jobs/${JOB_ID}`]: job("succeeded", 100),
        [`/exports/${EXPORT_ID}/download`]: {
          url: DOWNLOAD_URL,
          expiresAt: "2026-01-01T00:00:00Z",
        },
        // The eligibility answer that fired the second export.
        "/offers/eligibility": {
          signupGift: { available: true },
          ninePass: {
            available: false,
            eligibleToBuy: true,
            reason: null,
            nextEligibleAt: null,
            priceMinor: 900,
            currency: "INR",
          },
          weekPass: {
            active: false,
            endsAt: null,
            priceMinor: 14_900,
            currency: "INR",
            creditsGrantedTenths: 500,
            days: 7,
          },
          topupFree149: { available: true, priceMinor: 14_900, currency: "INR", credits: 150 },
        },
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-start"));
    });
    // Let the eligibility query settle and its effect run — this is the tick on
    // which the second export used to be created.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(exportsCreated(fetchMock)).toBe(1);
  });
});
