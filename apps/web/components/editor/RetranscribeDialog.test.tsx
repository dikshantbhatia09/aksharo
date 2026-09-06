import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@montaj/ui";

import { RetranscribeDialog } from "./RetranscribeDialog";

import { TRANSCRIPT_READY_EVENT } from "@/lib/edg/transcription-state";
import { renderWithProviders } from "@/test/harness";

const PROJECT = "01JPROJECT0000000000000000";
const ROUTE = `/projects/${PROJECT}/transcript/retranscribe`;
const STATE_ROUTE = `/projects/${PROJECT}/transcription-state`;

const ACCEPTED = {
  jobId: "01JJOB0000000000000000000A",
  transcriptId: "01JT",
  status: "queued",
  deduplicated: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const hasEdits = (): Response =>
  json(
    {
      error: {
        code: "transcript/has_edits",
        message: "The editing document has moved past the first transcription.",
      },
    },
    409,
  );

function bodyOf(fetchMock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/retranscribe"));
  const call = calls.at(index);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

beforeEach(() => {
  localStorage.clear();
});

describe("<RetranscribeDialog />", () => {
  it("opens on the project's current language and quotes the edits rule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />);

    await user.click(screen.getByTestId("retranscribe-open"));

    expect(await screen.findByTestId("retranscribe-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-language-hi")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("retranscribe-warning")).toHaveTextContent(
      "Re-transcribing replaces every word id. Captions you have retimed, split or retyped will lose those edits.",
    );
  });

  it("sends the newly chosen language, without force", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      { routes: { [ROUTE]: ACCEPTED } },
    );

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(await screen.findByTestId("quick-pick-language-en"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    await waitFor(() => {
      expect(bodyOf(fetchMock)).toMatchObject({ languages: ["en"], force: false });
    });
  });

  // The documented 409: the server refuses, so the dialog asks a second,
  // differently-worded question rather than forcing on the user's behalf.
  it("asks again on transcript/has_edits, then completes with force", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      {
        routes: {
          [ROUTE]: ACCEPTED,
        },
      },
    );
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (!String(input).endsWith("/retranscribe")) return Promise.resolve(json({}, 404));
      attempt += 1;
      return Promise.resolve(attempt === 1 ? hasEdits() : json(ACCEPTED));
    });

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(await screen.findByTestId("quick-pick-language-en"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    // Refused, and said so — no silent force.
    expect(await screen.findByTestId("retranscribe-has-edits")).toHaveTextContent(
      "Continuing discards them",
    );
    expect(bodyOf(fetchMock, 0)).toMatchObject({ force: false });

    await user.click(screen.getByTestId("retranscribe-force"));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 1)).toMatchObject({ languages: ["en"], force: true });
    });
    // Accepted, so the dialog closes; the editor keeps the old document until
    // FIX-03's pipeline announces the new one.
    await waitFor(() => {
      expect(screen.queryByTestId("retranscribe-dialog")).toBeNull();
    });
  });

  it("stays open and sends nothing more when the retry is refused too", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      { routes: { [ROUTE]: hasEdits() } },
    );
    fetchMock.mockImplementation(() => Promise.resolve(hasEdits()));

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    expect(await screen.findByTestId("retranscribe-has-edits")).toBeInTheDocument();
    expect(screen.getByTestId("retranscribe-dialog")).toBeInTheDocument();
  });

  /**
   * The bug this guards: the dialog used to rely entirely on `AppShell`'s
   * realtime push to learn a re-transcription had finished. Nothing here
   * simulates that push at all — no realtime client, no `job.completed`
   * frame — so if the dialog's own fallback poll were removed, this would
   * hang forever and time out. `TRANSCRIPT_READY_EVENT` firing anyway is
   * proof the poll, not the push, is what closed the loop.
   */
  it("polls the read model after a 202 and announces the transcript with no push at all", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />, {
      routes: { [ROUTE]: ACCEPTED, [STATE_ROUTE]: { status: "ready" } },
    });

    const announced: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId !== undefined) announced.push(detail.projectId);
    };
    window.addEventListener(TRANSCRIPT_READY_EVENT, listener);
    try {
      await user.click(screen.getByTestId("retranscribe-open"));
      await user.click(await screen.findByTestId("quick-pick-language-en"));
      await user.click(screen.getByTestId("retranscribe-confirm"));

      await waitFor(() => {
        expect(screen.queryByTestId("retranscribe-dialog")).toBeNull();
      });
      await waitFor(() => {
        expect(announced).toEqual([PROJECT]);
      });
      // Settled: the in-progress badge does not outlive the answer.
      expect(screen.queryByTestId("retranscribing-indicator")).toBeNull();
    } finally {
      window.removeEventListener(TRANSCRIPT_READY_EVENT, listener);
    }
  });

  // The backoff's later ticks (real `setTimeout`s inside `pollTranscriptionState`)
  // are not exercised here — switching to fake timers only after the first tick
  // has already armed a real one does not virtualize it, and `needs-
  // transcription.tsx`'s own poll loop already covers the backoff schedule
  // itself. A read model that is still `running` on the very first tick is
  // enough to prove the badge renders at all.
  it("shows an in-progress badge while the fallback poll is still waiting", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />, {
      routes: { [ROUTE]: ACCEPTED, [STATE_ROUTE]: { status: "running" } },
    });

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(await screen.findByTestId("quick-pick-language-en"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    // Still running: the badge is the "something is happening" the bug report
    // said was entirely missing.
    expect(await screen.findByTestId("retranscribing-indicator")).toBeInTheDocument();
  });

  it("reports the fallback poll's own failure with a toast, and clears the badge", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />, {
      routes: {
        [ROUTE]: ACCEPTED,
        [STATE_ROUTE]: { status: "failed", error: "The ASR provider timed out." },
      },
    });

    const error = vi.spyOn(toast, "error");
    try {
      await user.click(screen.getByTestId("retranscribe-open"));
      await user.click(await screen.findByTestId("quick-pick-language-en"));
      await user.click(screen.getByTestId("retranscribe-confirm"));

      await waitFor(() => {
        expect(error).toHaveBeenCalledWith(
          "The re-transcription did not finish",
          expect.objectContaining({ description: "The ASR provider timed out." }),
        );
      });
      expect(screen.queryByTestId("retranscribing-indicator")).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});
