import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RepurposeClipFormat, RepurposeClipItem } from "@montaj/api-client";

import { ClipEditingDownload, editingShapesOf } from "./ClipEditingDownload";
import { EDITING_DOWNLOAD_COPY } from "./download-copy";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders } from "@/test/harness";

const started = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("./start-download", () => ({
  startDownload: (url: string) => {
    started.urls.push(url);
  },
}));

const RUN = "01JS0000000000000000000RUN";
const CLIP = "01JS000000000000000000CLIP";
const PATH = `/repurpose/runs/${RUN}/clips/${CLIP}/nle-download`;
const LINK =
  "https://api.aksharo.test/repurpose/nle-downloads/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

function format(shape: RepurposeClipFormat["shape"], clean: boolean): RepurposeClipFormat {
  return {
    shape,
    status: "ready",
    projectId: `PRJ-${shape}`,
    captioned: null,
    cleanUrl: clean ? `https://media.test/${shape}.mp4` : null,
  };
}

const CLIP_ITEM: RepurposeClipItem = {
  id: CLIP,
  state: "ready",
  formats: [format("9:16", true), format("4:5", false), format("1:1", true), format("16:9", true)],
};

function render(clip: RepurposeClipItem | undefined, answer?: Response) {
  const posted: unknown[] = [];
  const view = renderWithProviders(<ClipEditingDownload runId={RUN} clip={clip} />);
  view.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname !== PATH || init?.method !== "POST") {
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    posted.push(JSON.parse(String(init.body)) as unknown);
    return Promise.resolve(
      answer ??
        new Response(JSON.stringify({ url: LINK, expiresAt: "2026-10-01T10:05:00.000Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
  });
  return { ...view, posted };
}

describe("editingShapesOf", () => {
  it("offers the sizes whose version without captions is stored, in the usual order", () => {
    expect(editingShapesOf(CLIP_ITEM)).toEqual(["9:16", "1:1", "16:9"]);
  });

  it("offers nothing for a clip not made yet", () => {
    expect(editingShapesOf(undefined)).toEqual([]);
    expect(editingShapesOf({ ...CLIP_ITEM, state: "cutting" })).toEqual([]);
  });

  it("offers the 9:16 from an older answer without formats", () => {
    expect(
      editingShapesOf({
        id: CLIP,
        state: "ready",
        variants: [{ id: "v", projectId: "p", aspect: "r9x16" }],
      }),
    ).toEqual(["9:16"]);
  });
});

describe("ClipEditingDownload", () => {
  it("asks for the size picked and sends the browser to the single-use link", async () => {
    started.urls.length = 0;
    const { posted } = render(CLIP_ITEM);
    const section = screen.getByTestId("clip-editing-download");
    expect(section).toHaveTextContent(EDITING_DOWNLOAD_COPY.heading);
    expect(screen.getByTestId("clip-editing-shape-9x16")).toBeChecked();
    expect(screen.queryByTestId("clip-editing-shape-4x5")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: EDITING_DOWNLOAD_COPY.shape["16:9"] }));
    expect(screen.getByTestId("clip-editing-shape-16x9")).toBeChecked();
    expect(screen.getByTestId("clip-editing-shape-9x16")).not.toBeChecked();
    await userEvent.click(screen.getByTestId("clip-editing-download-start"));

    await waitFor(() => {
      expect(started.urls).toEqual([LINK]);
    });
    expect(posted).toEqual([{ shape: "16:9" }]);
    expect(await screen.findByTestId("clip-editing-download-started")).toBeInTheDocument();
  });

  it("is a radio group the arrow keys move through, with one tab stop", async () => {
    render(CLIP_ITEM);
    const group = screen.getByRole("group", { name: EDITING_DOWNLOAD_COPY.sizeLegend });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(group).toContainElement(radio);
    // Native radios sharing one name: the browser gives them one tab stop and
    // moves (and picks) with the arrow keys.
    const names = new Set(radios.map((radio) => radio.getAttribute("name")));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();

    await userEvent.tab();
    expect(screen.getByTestId("clip-editing-shape-9x16")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("clip-editing-shape-1x1")).toBeChecked();
    expect(screen.getByTestId("clip-editing-shape-1x1")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByTestId("clip-editing-download-start")).toHaveFocus();
  });

  it("shows no size choice when there is only one", () => {
    render({ ...CLIP_ITEM, formats: [format("9:16", true)] });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByTestId("clip-editing-download-start")).toBeInTheDocument();
  });

  it("says plainly when the size is not ready yet", async () => {
    started.urls.length = 0;
    render(
      CLIP_ITEM,
      new Response(
        JSON.stringify({
          error: { code: "repurpose/nle_not_ready", message: "not ready" },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    await userEvent.click(screen.getByTestId("clip-editing-download-start"));
    expect(await screen.findByTestId("clip-editing-download-error")).toHaveTextContent(
      "This size is not ready yet",
    );
    expect(started.urls).toEqual([]);
  });

  it("renders nothing for a clip with no stored version without captions", () => {
    const { container } = render({ ...CLIP_ITEM, formats: [format("9:16", false)] });
    expect(container).toBeEmptyDOMElement();
  });

  it("uses no word a person should never see", () => {
    const words = [
      EDITING_DOWNLOAD_COPY.heading,
      EDITING_DOWNLOAD_COPY.hint,
      EDITING_DOWNLOAD_COPY.download,
      EDITING_DOWNLOAD_COPY.started,
      ...Object.values(EDITING_DOWNLOAD_COPY.shape),
    ].join(" ");
    expect(beginnerSafetyViolations(words)).toEqual([]);
  });
});
