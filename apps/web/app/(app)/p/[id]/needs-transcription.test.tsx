import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { NeedsTranscription } from "./needs-transcription";

import { renderWithProviders } from "@/test/harness";

const PROJECT = {
  id: "01PROJECT",
  title: "Villa walkthrough",
  status: "active",
  sourceLanguage: "hi-Latn",
  scripts: [],
};

const STATE_ROUTE = "/projects/01PROJECT/transcription-state";
const TRANSCRIBE_ROUTE = "/projects/01PROJECT/transcribe";
const IMPORT_ROUTE = "/projects/01PROJECT/import";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("<NeedsTranscription />", () => {
  // The editor used to dead-end here with a red sentence and no way forward.
  it("offers the work instead of an error", async () => {
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "has not been transcribed yet",
      );
    });
    expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
  });

  it("starts transcription in the project's own language", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
    });

    // From here the read model answers the way the server would once a job row
    // exists, so the screen's own transition is exercised rather than stubbed.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const { pathname } = new URL(typeof input === "string" ? input : input.toString());
      if (pathname === TRANSCRIBE_ROUTE) {
        return Promise.resolve(json({ jobId: "01JOB", transcriptId: "01T" }));
      }
      if (pathname === STATE_ROUTE) return Promise.resolve(json({ status: "queued" }));
      return Promise.resolve(json(PROJECT));
    });

    await user.click(screen.getByTestId("editor-start-transcription"));

    const call = await waitFor(() => {
      const found = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/transcribe"));
      expect(found).toBeDefined();
      return found;
    });
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ languages: ["hi-Latn"] });

    // The old assertion here checked the Start button went *disabled* — that was
    // the removed `started` boolean. The state model's truth is that a queued
    // project offers no start at all.
    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent("Transcribing");
    });
    expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
  });

  // The audit's headline defect from the user's side: a transcription that IS
  // running must never be presented as work waiting to be commissioned.
  it("shows the transcribing spinner and no start button while a job runs", async () => {
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "running", jobId: "01JOB" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent("Transcribing");
    });
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "This page updates by itself",
    );
    expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
  });

  // A zero-credit workspace used to get a silent nothing. The 402 is the credit
  // UX: it belongs on the screen, in place, not in a toast that disappears.
  it("surfaces a 402 credits/insufficient as the blocked-credits panel", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
        [TRANSCRIBE_ROUTE]: json(
          {
            error: {
              code: "credits/insufficient",
              message: "This workspace has no credits left.",
            },
          },
          402,
        ),
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
    });

    await user.click(screen.getByTestId("editor-start-transcription"));

    await waitFor(() => {
      expect(screen.getByTestId("transcription-blocked-credits")).toHaveTextContent(
        "out of credits",
      );
    });
    expect(screen.getByTestId("transcription-blocked-credits")).toHaveTextContent(
      "Ask an administrator to grant more",
    );
    // Still recoverable in place — QA6 grants credits and presses this.
    expect(screen.getByTestId("editor-start-transcription")).toHaveTextContent("Try again");
  });
  /**
   * S-03: the credit-free path. The offer belongs on the same screen as the
   * paid one — a creator who already has captions should never have to spend a
   * transcription to see them — and taking it must visibly become a wait, not
   * leave the screen still offering the work it just commissioned.
   */
  it("offers a credit-free import and turns into the aligning wait", async () => {
    const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
        [IMPORT_ROUTE]: json(
          {
            mediaId: "01MEDIA",
            kind: "srt",
            key: "derived/01PROJECT/subtitles.json",
            cueCount: 3,
            timed: true,
            warnings: [],
            jobId: "01JALIGN",
          },
          201,
        ),
      },
    });

    // The offer sits under the primary action, never instead of it.
    expect(await screen.findByTestId("import-subtitles")).toBeEnabled();
    expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "costs no transcription credits",
    );

    fireEvent.change(screen.getByTestId("import-subtitles-input"), {
      target: {
        files: [
          new File(["1\n00:00:00,000 --> 00:00:01,000\nHello\n"], "qa.srt", { type: "text/plain" }),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Aligning your subtitles",
      );
    });
    // No transcription was commissioned on the way — that is the whole point.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/transcribe"))).toBe(false);
    expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
  });

  // FIX-04: the one state on this screen that holds a question. A project with
  // no recorded language used to be a dead end — Home was the only writer of
  // the field and it always wrote `hi-Latn`.
  describe("awaiting_language", () => {
    const NO_LANGUAGE = { ...PROJECT, sourceLanguage: null };

    it("offers the picker instead of a start button", async () => {
      renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
        routes: {
          "/projects/01PROJECT": NO_LANGUAGE,
          [STATE_ROUTE]: { status: "awaiting_language" },
        },
      });

      expect(await screen.findByTestId("quickpick-language")).toBeInTheDocument();
      expect(screen.getByTestId("quickpick-language")).toHaveAttribute("data-language", "");
      expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
    });

    it("records the language and starts the work on one gesture", async () => {
      const user = userEvent.setup();
      const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
        routes: {
          "/projects/01PROJECT": NO_LANGUAGE,
          [STATE_ROUTE]: { status: "awaiting_language" },
        },
      });
      await screen.findByTestId("quickpick-language");

      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const { pathname } = new URL(typeof input === "string" ? input : input.toString());
        if (pathname === TRANSCRIBE_ROUTE) {
          return Promise.resolve(json({ jobId: "01JOB", transcriptId: "01T" }));
        }
        if (pathname === STATE_ROUTE) return Promise.resolve(json({ status: "queued" }));
        if (init?.method === "PATCH")
          return Promise.resolve(json({ ...PROJECT, sourceLanguage: "hi" }));
        return Promise.resolve(json({ ...PROJECT, sourceLanguage: "hi" }));
      });

      await user.click(screen.getByTestId("quick-pick-language-hi"));

      // The project carries the choice...
      const patch = await waitFor(() => {
        const found = fetchMock.mock.calls.find(
          ([url, init]) =>
            String(url).endsWith("/projects/01PROJECT") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(found).toBeDefined();
        return found;
      });
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        sourceLanguage: "hi",
      });

      // ...and the work starts in it, with no second click.
      const transcribe = await waitFor(() => {
        const found = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/transcribe"));
        expect(found).toBeDefined();
        return found;
      });
      expect(JSON.parse(String(transcribe?.[1]?.body))).toMatchObject({ languages: ["hi"] });

      // ...and the screen falls into the queued poll path it already had.
      await waitFor(() => {
        expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent("Transcribing");
      });
    });

    it("does not start anything when recording the language fails", async () => {
      const user = userEvent.setup();
      const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
        routes: {
          "/projects/01PROJECT": NO_LANGUAGE,
          [STATE_ROUTE]: { status: "awaiting_language" },
        },
      });
      await screen.findByTestId("quickpick-language");

      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const { pathname } = new URL(typeof input === "string" ? input : input.toString());
        if (pathname === STATE_ROUTE) {
          return Promise.resolve(json({ status: "awaiting_language" }));
        }
        if (init?.method === "PATCH") {
          return Promise.resolve(
            json({ error: { code: "common/bad_request", message: "no." } }, 400),
          );
        }
        return Promise.resolve(json(NO_LANGUAGE));
      });

      await user.click(screen.getByTestId("quick-pick-language-hi"));

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
          ),
        ).toBe(true);
      });
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/transcribe"))).toBe(false);
    });
  });
});
