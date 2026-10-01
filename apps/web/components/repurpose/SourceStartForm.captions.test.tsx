import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import {
  CAPTIONS_MAX_BYTES,
  captionsKindOf,
  captionsLinkProblem,
  captionsToSend,
  givesCaptions,
  offersCaptions,
} from "./run-captions";
import {
  EMPTY_START_FORM,
  SourceStartForm,
  validateStartForm,
  type StartFormValue,
} from "./SourceStartForm";

/**
 * Captions the person already has (2026-10-01, OpusClip's "upload SRT"): an
 * optional SRT or VTT file, or a link to one, for a single video. The run uses
 * it instead of a paid transcription.
 */
function Harness({
  initial = EMPTY_START_FORM,
  allowSeveralFiles = false,
  onValue,
}: {
  readonly initial?: StartFormValue;
  readonly allowSeveralFiles?: boolean;
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>(initial);
  onValue?.(value);
  return (
    <SourceStartForm
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      allowSeveralFiles={allowSeveralFiles}
      allowSeveralLinks
    />
  );
}

const SRT_TEXT = "1\n00:00:00,000 --> 00:00:02,000\nhello there\n";
const srt = (): File => new File([SRT_TEXT], "talk.srt", { type: "application/x-subrip" });
const vtt = (): File => new File(["WEBVTT\n\n00:00.000 --> 00:02.000\nhi\n"], "talk.VTT");
const mp4 = (name = "talk.mp4"): File => new File(["ftyp"], name, { type: "video/mp4" });

describe("<SourceStartForm /> with captions", () => {
  it("offers a caption file for one link, and takes it off again", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;
    render(
      <Harness
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    expect(screen.getByTestId("source-captions")).toBeInTheDocument();
    expect(screen.getByTestId("source-captions-input").getAttribute("accept")).toContain(".srt");

    await user.upload(screen.getByTestId("source-captions-input"), srt());
    expect(latest.captionsFile?.name).toBe("talk.srt");
    expect(screen.getByTestId("source-captions-name")).toHaveTextContent("talk.srt");
    // A picked file wins: the link box goes away while it is there.
    expect(screen.queryByTestId("source-captions-url")).toBeNull();

    await user.click(screen.getByTestId("source-captions-remove"));
    expect(latest.captionsFile).toBeNull();
    expect(screen.getByTestId("source-captions-url")).toBeInTheDocument();
  });

  it("takes a link to a caption file instead", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;
    render(
      <Harness
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await user.type(screen.getByTestId("source-captions-url"), "https://example.com/a.vtt");
    expect(latest.captionsUrl).toBe("https://example.com/a.vtt");
  });

  it("offers captions for one uploaded file, never for several or for several links", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...EMPTY_START_FORM, tab: "upload" }} allowSeveralFiles />);
    expect(screen.getByTestId("source-captions")).toBeInTheDocument();
    await user.upload(screen.getByTestId("source-file"), [mp4("a.mp4"), mp4("b.mp4")]);
    expect(screen.queryByTestId("source-captions")).toBeNull();

    await user.click(screen.getByTestId("source-tab-links"));
    expect(screen.queryByTestId("source-captions")).toBeNull();
  });

  it("shows a caption problem once the form is sent", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...EMPTY_START_FORM,
          url: "https://youtu.be/abc123def45",
          rightsAttested: true,
          captionsUrl: "https://example.com/captions.txt",
        }}
      />,
    );
    expect(screen.queryByText(/should end in .srt or .vtt/)).toBeNull();
    await user.click(screen.getByTestId("start-run"));
    expect(screen.getByText(/should end in .srt or .vtt/)).toBeInTheDocument();
  });
});

describe("the captions' rules", () => {
  const link = (patch: Partial<StartFormValue>): StartFormValue => ({
    ...EMPTY_START_FORM,
    url: "https://youtu.be/abc123def45",
    rightsAttested: true,
    ...patch,
  });

  it("takes SRT and VTT by name, nothing else", () => {
    expect(captionsKindOf("talk.srt")).toBe("srt");
    expect(captionsKindOf("talk.VTT")).toBe("vtt");
    expect(captionsKindOf("https://x.com/a.srt?dl=1")).toBe("srt");
    expect(captionsKindOf("talk.ass")).toBeUndefined();
    expect(captionsKindOf("talk.txt")).toBeUndefined();
  });

  it("refuses another format, an empty file and one over 2 MB", () => {
    const ass = new File(["[Script Info]"], "talk.ass");
    expect(validateStartForm(link({ captionsFile: ass })).captions).toBe(
      "Choose an SRT or VTT caption file.",
    );
    expect(validateStartForm(link({ captionsFile: new File([], "talk.srt") })).captions).toBe(
      "That caption file is empty.",
    );
    const huge = new File([new Uint8Array(CAPTIONS_MAX_BYTES + 1)], "talk.srt");
    expect(validateStartForm(link({ captionsFile: huge })).captions).toMatch(/larger than 2 MB/);
    expect(validateStartForm(link({ captionsFile: srt() })).captions).toBeUndefined();
    // None at all is fine: it is optional.
    expect(validateStartForm(link({})).captions).toBeUndefined();
  });

  it("refuses a link that is not a web address or not a caption file", () => {
    expect(captionsLinkProblem("")).toBeNull();
    expect(captionsLinkProblem("captions.srt")).toMatch(/starting with https/);
    expect(captionsLinkProblem("ftp://example.com/a.srt")).toMatch(/starting with https/);
    expect(captionsLinkProblem("https://example.com/a.txt")).toMatch(/end in .srt or .vtt/);
    expect(captionsLinkProblem("https://example.com/a.srt")).toBeNull();
  });

  it("is offered for one video only", () => {
    expect(offersCaptions(link({}))).toBe(true);
    expect(offersCaptions(link({ tab: "upload", file: mp4() }))).toBe(true);
    expect(offersCaptions(link({ tab: "upload", files: [mp4(), mp4()] }))).toBe(false);
    expect(offersCaptions(link({ tab: "links" }))).toBe(false);
    expect(givesCaptions(link({ tab: "links", captionsFile: srt() }))).toBe(false);
    expect(givesCaptions(link({ captionsUrl: "  " }))).toBe(false);
    expect(givesCaptions(link({ captionsFile: srt() }))).toBe(true);
  });

  it("sends a picked file as its text, else the link", async () => {
    await expect(captionsToSend(link({ captionsFile: srt() }))).resolves.toEqual({
      from: "file",
      kind: "srt",
      content: SRT_TEXT,
    });
    await expect(captionsToSend(link({ captionsFile: vtt() }))).resolves.toMatchObject({
      from: "file",
      kind: "vtt",
    });
    await expect(
      captionsToSend(link({ captionsUrl: " https://example.com/a.vtt " })),
    ).resolves.toEqual({ from: "url", url: "https://example.com/a.vtt", kind: "vtt" });
    await expect(captionsToSend(link({}))).resolves.toBeUndefined();
    await expect(
      captionsToSend(link({ tab: "links", captionsFile: srt() })),
    ).resolves.toBeUndefined();
  });
});
