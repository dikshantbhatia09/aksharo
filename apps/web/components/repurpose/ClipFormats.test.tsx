import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepurposeClipFormat } from "@montaj/api-client";

import { ClipFormats, tooLongFor } from "./ClipFormats";


const CAND = "01JS000000000000000000CAND";

function format(shape: RepurposeClipFormat["shape"], over: Partial<RepurposeClipFormat> = {}) {
  const tag = shape.replace(":", "x");
  return {
    shape,
    status: "ready",
    projectId: `p-${tag}`,
    captioned: { status: "ready", playUrl: `play-${tag}`, downloadUrl: `dl-${tag}` },
    cleanUrl: `clean-${tag}`,
    ...over,
  } as RepurposeClipFormat;
}

describe("ClipFormats", () => {
  it("lists each shape with where it fits, its downloads and its editor", () => {
    render(
      <ClipFormats
        candidateId={CAND}
        title="A moment"
        durationMs={75_000}
        formats={[
          format("9:16"),
          format("4:5"),
          format("1:1", { status: "preparing", captioned: null, cleanUrl: null, projectId: null }),
          format("16:9", { status: "failed" }),
        ]}
        images={{
          status: "ready",
          files: [
            {
              id: "carousel",
              width: 1080,
              height: 1350,
              items: [
                { url: "c1", downloadUrl: "c1-dl" },
                { url: "c2", downloadUrl: "c2-dl" },
              ],
            },
            {
              id: "thumbnail",
              width: 1280,
              height: 720,
              items: [{ url: "t", downloadUrl: "t-dl" }],
            },
          ],
        }}
      />,
    );

    const vertical = screen.getByTestId(`clip-format-${CAND}-9x16`);
    expect(vertical).toHaveTextContent("Instagram Reel");
    expect(vertical).toHaveTextContent("YouTube Short");
    // 75 s is past a Story's 60 s.
    expect(vertical).toHaveTextContent("Instagram Story takes up to 60 s");
    expect(within(vertical).getByLabelText(/with captions/)).toHaveAttribute("href", "dl-9x16");
    expect(within(vertical).getByLabelText(/without captions/)).toHaveAttribute(
      "href",
      "clean-9x16",
    );
    expect(within(vertical).getByText("Edit")).toHaveAttribute("href", "/p/p-9x16");

    expect(screen.getByTestId(`clip-format-${CAND}-1x1`)).toHaveTextContent("Being made");
    expect(screen.getByTestId(`clip-format-${CAND}-16x9`)).toHaveTextContent("Could not be made");

    const carousel = screen.getByTestId(`clip-image-${CAND}-carousel`);
    expect(within(carousel).getByText("Slide 2")).toHaveAttribute("href", "c2-dl");
    expect(carousel).toHaveTextContent("1080 × 1350");
    expect(screen.getByTestId(`clip-image-${CAND}-thumbnail`)).toHaveTextContent(
      "YouTube Thumbnail",
    );
  });

  it("shows nothing for a clip that only has its 9:16 video", () => {
    const { container } = render(
      <ClipFormats
        candidateId={CAND}
        title="A moment"
        durationMs={30_000}
        formats={[format("9:16")]}
        images={{ status: "none", files: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("tooLongFor", () => {
  it("names each place a clip is too long for", () => {
    expect(tooLongFor("9:16", 30_000)).toEqual([]);
    expect(tooLongFor("16:9", 150_000)).toEqual(["X Video (16:9) takes up to 140 s"]);
  });
});
