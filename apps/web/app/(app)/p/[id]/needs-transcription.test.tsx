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
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Generating your captions",
      );
    });
    expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
  });

  // The audit's headline defect from the user's side: a transcription that IS
  // running must never be presented as work waiting to be commissioned.
  it("shows the full-screen generating state and no start button while a job runs", async () => {
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "running", jobId: "01JOB" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Generating your captions",
      );
    });
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "This page updates by itself",
    );
    expect(screen.queryByTestId("editor-start-transcription")).toBeNull();
    // K02 acceptance criterion 3: full-screen, with a rotating tip, honestly
    // reflecting the real state (no progress percentage claimed for a job the
    // pipeline reports no bytes-level progress for).
    expect(screen.getByTestId("processing-screen")).toBeInTheDocument();
    expect(screen.getByTestId("processing-tip")).toBeInTheDocument();
  });

  // K02: `processing_media` (FIX-03's read model) is the full-screen
  // "Analyzing your media" state — probe/proxy running, transcription not
  // started yet. Distinct copy from `queued`/`running` so the state never
  // claims work that has not begun.
  it("shows the full-screen analyzing state for processing_media", async () => {
    renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "processing_media" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Analyzing your media",
      );
    });
    expect(screen.getByTestId("processing-screen")).toBeInTheDocument();
    expect(screen.getByTestId("processing-tip")).toBeInTheDocument();
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

  // S-06: the ending that used to fall through the floor. The read model looked
  // only at `ai.transcribe`, so a failed `ai.align` answered `not_started` and
  // this phase — which settled on `ready` alone — span forever.
  it("settles the aligning wait on a failed alignment, with a way back to the offer", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
      },
    });

    expect(await screen.findByTestId("import-subtitles")).toBeEnabled();

    // `not_started` settled the offer's poll, so nothing is in flight. From here
    // the read model answers the way the server now would with the align job
    // failed — which is the whole of S-06 step 2, seen from the browser.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const { pathname } = new URL(typeof input === "string" ? input : input.toString());
      if (pathname === IMPORT_ROUTE) {
        return Promise.resolve(
          json(
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
        );
      }
      if (pathname === STATE_ROUTE) {
        return Promise.resolve(
          json({
            status: "failed",
            jobId: "01JALIGN",
            error: "Could not match the subtitles to the audio.",
          }),
        );
      }
      return Promise.resolve(json(PROJECT));
    });

    fireEvent.change(screen.getByTestId("import-subtitles-input"), {
      target: {
        files: [
          new File(["1\n00:00:00,000 --> 00:00:01,000\nHello\n"], "qa.srt", { type: "text/plain" }),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Aligning your subtitles failed",
      );
    });
    // The failure's own sentence, not a generic one.
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "Could not match the subtitles to the audio.",
    );
    // Transcription is still on offer as the primary way forward.
    expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();

    await user.click(screen.getByTestId("aligning-try-another-file"));

    // Back at the offer, with the import control — even though the server is
    // still reporting the failed align job it has no newer one to replace.
    expect(await screen.findByTestId("import-subtitles")).toBeEnabled();
    expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
      "has not been transcribed yet",
    );
    expect(screen.getByTestId("editor-start-transcription")).toBeEnabled();
  });

  // S-06 follow-up: the second import must not wear the first one's verdict.
  // `onQueued` moves the phase back to `aligning` synchronously, so a `view`
  // still holding the previous `failed` answer would render one frame of the OLD
  // failure before the restarted poll's first tick could correct it.
  it("does not show the previous failure when a second file is imported", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NeedsTranscription projectId="01PROJECT" />, {
      routes: {
        "/projects/01PROJECT": PROJECT,
        [STATE_ROUTE]: { status: "not_started" },
      },
    });

    expect(await screen.findByTestId("import-subtitles")).toBeEnabled();

    const importBody = {
      mediaId: "01MEDIA",
      kind: "srt",
      key: "derived/01PROJECT/subtitles.json",
      cueCount: 3,
      timed: true,
      warnings: [],
      jobId: "01JALIGN",
    };
    // The read model's answer, swapped when the second alignment is queued.
    const stateAnswer: Record<string, unknown> = {
      status: "failed",
      jobId: "01JALIGN",
      error: "Could not match the subtitles to the audio.",
    };
    // After the second import the answer is held open, so the frame under test is
    // the one the screen renders from its OWN state, before any new answer — which
    // is exactly where a stale `view` would show through.
    let holdState = false;
    let releaseState: (() => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const { pathname } = new URL(typeof input === "string" ? input : input.toString());
      if (pathname === IMPORT_ROUTE) return Promise.resolve(json(importBody, 201));
      if (pathname === STATE_ROUTE) {
        if (!holdState) return Promise.resolve(json(stateAnswer));
        return new Promise<Response>((resolve) => {
          releaseState = () => {
            resolve(json({ status: "queued", jobId: "01JALIGN2" }));
          };
        });
      }
      return Promise.resolve(json(PROJECT));
    });

    const pick = (name: string): void => {
      fireEvent.change(screen.getByTestId("import-subtitles-input"), {
        target: {
          files: [
            new File(["1\n00:00:00,000 --> 00:00:01,000\nHello\n"], name, { type: "text/plain" }),
          ],
        },
      });
    };

    pick("first.srt");
    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Aligning your subtitles failed",
      );
    });

    await user.click(screen.getByTestId("aligning-try-another-file"));
    expect(await screen.findByTestId("import-subtitles")).toBeEnabled();

    // The second import. The screen must wait on the NEW alignment, never
    // re-announce the first one's verdict.
    holdState = true;
    pick("second.srt");
    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Aligning your subtitles…",
      );
    });
    expect(screen.getByTestId("editor-needs-transcription")).not.toHaveTextContent(
      "Aligning your subtitles failed",
    );

    // Let the new alignment's own answer land; the wait carries on as a wait.
    releaseState?.();
    await waitFor(() => {
      expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
        "Aligning your subtitles…",
      );
    });
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

    // K02: the picker is now a searchable combobox (`language-picker.tsx`) — a
    // pick opens the trigger first rather than clicking a per-language button
    // directly.

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

      await user.click(screen.getByTestId("quick-pick-language-trigger"));
      await user.click(await screen.findByTestId("quick-pick-language-hi"));

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
        expect(screen.getByTestId("editor-needs-transcription")).toHaveTextContent(
          "Generating your captions",
        );
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

      await user.click(screen.getByTestId("quick-pick-language-trigger"));
      await user.click(await screen.findByTestId("quick-pick-language-hi"));

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
