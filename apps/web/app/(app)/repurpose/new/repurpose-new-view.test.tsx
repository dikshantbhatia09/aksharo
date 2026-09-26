import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepurposeNewView } from "./repurpose-new-view";

import { recallRunSetup } from "@/components/repurpose/run-setup";
import { renderWithProviders } from "@/test/harness";
import { routerMock, searchParamsMock } from "@/test/next-router";

// The queue resumes uploads from IndexedDB on mount; a link run never uses it.
vi.mock("@/lib/upload/use-upload-queue", () => ({
  useUploadQueue: () => ({
    items: [],
    addFiles: vi.fn(),
    addFilesToProjects: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/**
 * `/repurpose/new` (clips hardening, 2026-09-26): Home and `/repurpose` hand it
 * scheme-less links on purpose, and it used to refuse every one; a refusal
 * showed the API's own words ("This workspace already has 2 jobs in flight");
 * and a link already being worked on was a dead end.
 */
const RUN_ID = "01JS0000000000000000000NEW";
const RUNS = "/repurpose/runs";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createBodies(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === "POST" &&
        new URL(String(input)).pathname === RUNS,
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
}

async function startWithPrefilledLink(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("rights-attested"));
  await user.click(screen.getByTestId("start-run"));
}

describe("<RepurposeNewView />", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
    searchParamsMock.value = new URLSearchParams({ url: "youtube.com/watch?v=dQw4w9WgXcQ", lang: "en" });
  });

  it("sends a scheme-less link as https, and remembers the setup for this run", async () => {
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(201, {
          run: { id: RUN_ID },
          projectId: "01JPROJECT",
          upload: null,
          next: { rel: "run", href: `/repurpose/runs/${RUN_ID}` },
        }),
      },
    });
    expect(screen.getByTestId("source-url")).toHaveValue("youtube.com/watch?v=dQw4w9WgXcQ");

    await startWithPrefilledLink();

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${RUN_ID}`);
    });
    const [body] = createBodies(fetchMock) as [{ source: { url: string } }];
    expect(body.source.url).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    // So a failure can offer the same link and look back.
    expect(recallRunSetup(RUN_ID)?.link).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("offers the run already working on this link instead of a dead end", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(409, {
          error: {
            code: "repurpose/source_already_running",
            message: "Duplicate live source fingerprint.",
            details: { existingRunId: "01JS0000000000000000000OLD" },
          },
        }),
      },
    });

    await startWithPrefilledLink();

    expect(await screen.findByTestId("start-server-error")).toHaveTextContent(
      "You are already working on this video.",
    );
    expect(screen.getByTestId("start-existing-run")).toHaveAttribute(
      "href",
      "/repurpose/01JS0000000000000000000OLD",
    );
    expect(screen.queryByText(/fingerprint/)).toBeNull();
  });

  it("never shows an admission refusal's own words", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [RUNS]: json(429, {
          error: {
            code: "jobs/concurrency_cap",
            message: "This workspace already has 2 jobs in flight; the free plan allows 2.",
          },
        }),
      },
    });

    await startWithPrefilledLink();

    expect(await screen.findByTestId("start-server-error")).toHaveTextContent(
      "Your other videos are still being prepared. Try again in about a minute.",
    );
    expect(screen.queryByText(/jobs in flight/)).toBeNull();
    expect(screen.queryByTestId("start-existing-run")).toBeNull();
  });
});
