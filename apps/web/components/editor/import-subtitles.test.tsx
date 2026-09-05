import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as UiModule from "@montaj/ui";

import { ImportSubtitles } from "./ImportSubtitles";

import { renderWithProviders } from "@/test/harness";

/**
 * S-03. The three things that can happen when a creator hands the app a
 * subtitle file, asserted against the route's real contract
 * (`importSubtitlesSchema`, `apps/api/src/media/media.dto.ts:64`): the body is
 * `{kind, content}` — there is no `filename` field, and `kind` is the enum's
 * own string — the size ceiling is checked before anything is sent, and the
 * parser's own message is what the user is shown.
 */

const IMPORT_ROUTE = "/projects/01P/import";

const SRT = [
  "1",
  "00:00:00,000 --> 00:00:01,500",
  "Namaste",
  "",
  "2",
  "00:00:01,500 --> 00:00:03,000",
  "Aap kaise hain",
  "",
].join("\n");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESULT = {
  mediaId: "01MEDIA",
  kind: "srt",
  key: "derived/01P/subtitles.json",
  cueCount: 2,
  timed: true,
  warnings: [],
  jobId: "01JALIGN",
};

function choose(contents: BlobPart[], name: string): void {
  fireEvent.change(screen.getByTestId("import-subtitles-input"), {
    target: { files: [new File(contents, name, { type: "text/plain" })] },
  });
}

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@montaj/ui", async () => {
  const actual = await vi.importActual<typeof UiModule>("@montaj/ui");
  return { ...actual, toast: { ...actual.toast, error: toasts.error, success: toasts.success } };
});

beforeEach(() => {
  toasts.error.mockReset();
  toasts.success.mockReset();
});

describe("<ImportSubtitles />", () => {
  it("posts the schema's body for a chosen .srt and reports the queued alignment", async () => {
    const onQueued = vi.fn();
    const { fetchMock } = renderWithProviders(
      <ImportSubtitles projectId="01P" onQueued={onQueued} />,
      { routes: { [IMPORT_ROUTE]: json(RESULT, 201) } },
    );

    choose([SRT], "qa.srt");

    const call = await waitFor(() => {
      const found = fetchMock.mock.calls.find(([url]) => String(url).endsWith(IMPORT_ROUTE));
      expect(found).toBeDefined();
      return found;
    });
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    // Exactly the schema's fields — `kind` off the extension, `content` as text.
    expect(JSON.parse(String(init.body))).toEqual({ kind: "srt", content: SRT });

    await waitFor(() => {
      expect(onQueued).toHaveBeenCalledOnce();
    });
    expect(toasts.success).toHaveBeenCalledWith(
      "Subtitles imported",
      expect.objectContaining({ description: expect.stringContaining("Aligning") }),
    );
  });

  it("refuses an oversize file without sending anything", async () => {
    const onQueued = vi.fn();
    const { fetchMock } = renderWithProviders(
      <ImportSubtitles projectId="01P" onQueued={onQueued} />,
      { routes: { [IMPORT_ROUTE]: json(RESULT, 201) } },
    );

    // One byte over `IMPORT_MAX_BYTES` (`projects.constants.ts:68`).
    choose([new Uint8Array(2 * 1024 * 1024 + 1)], "huge.srt");

    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith("That file is too large for a subtitle import");
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(IMPORT_ROUTE))).toBe(false);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("shows the route's own parse message when the file cannot be read", async () => {
    const onQueued = vi.fn();
    renderWithProviders(<ImportSubtitles projectId="01P" onQueued={onQueued} />, {
      routes: {
        [IMPORT_ROUTE]: json(
          {
            error: {
              code: "import/unparsable",
              message: "No cue in this SRT had a usable timestamp.",
            },
          },
          422,
        ),
      },
    });

    choose(["\u0000\u0001 not a subtitle at all"], "broken.srt");

    await waitFor(() => {
      expect(toasts.error).toHaveBeenCalledWith("Could not import those subtitles", {
        // `import/unparsable` has no entry in `lib/errors.ts`, so the API's own
        // sentence survives to the user — which is the useful one here.
        description: "No cue in this SRT had a usable timestamp.",
      });
    });
    expect(onQueued).not.toHaveBeenCalled();
    // Recoverable: the control is offered again, not left spinning.
    expect(screen.getByTestId("import-subtitles")).toBeEnabled();
  });
});
