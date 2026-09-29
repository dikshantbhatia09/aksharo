import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import {
  EMPTY_START_FORM,
  SourceStartForm,
  coverToSend,
  picksAudio,
  validateStartForm,
  type StartFormValue,
} from "./SourceStartForm";
import { isAudioFile } from "./use-cover";

/**
 * Audio files on the start form (2026-10-04, audiograms): the upload tab takes
 * a podcast as well as a video, and a sound-only file is offered a cover image
 * for the picture its clips are drawn with.
 */
function Harness({
  onValue,
}: {
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>({ ...EMPTY_START_FORM, tab: "upload" });
  onValue?.(value);
  return <SourceStartForm value={value} onChange={setValue} onSubmit={() => undefined} />;
}

const mp3 = (): File => new File(["id3"], "episode-12.mp3", { type: "audio/mpeg" });
const mp4 = (): File => new File(["ftyp"], "talk.mp4", { type: "video/mp4" });
const png = (): File => new File(["png"], "cover.png", { type: "image/png" });

describe("<SourceStartForm /> with an audio file", () => {
  it("lets the picker offer audio files, not only videos", () => {
    render(<Harness />);
    const accept = screen.getByTestId("source-file").getAttribute("accept") ?? "";
    expect(accept).toContain(".mp3");
    expect(accept).toContain("audio/mpeg");
    expect(accept).toContain(".mp4");
    expect(screen.getByTestId("source-tab-upload")).toHaveTextContent("Upload a file");
  });

  it("offers a cover for a sound-only file, and takes it off again", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue = EMPTY_START_FORM;
    render(
      <Harness
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    expect(screen.queryByTestId("source-cover")).toBeNull();

    await user.upload(screen.getByTestId("source-file"), mp3());
    expect(screen.getByTestId("source-cover")).toBeInTheDocument();
    expect(screen.getByTestId("source-cover-input")).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp",
    );

    await user.upload(screen.getByTestId("source-cover-input"), png());
    expect(latest.cover?.name).toBe("cover.png");
    expect(screen.getByTestId("source-cover-name")).toHaveTextContent("cover.png");

    await user.click(screen.getByTestId("source-cover-remove"));
    expect(latest.cover).toBeNull();
  });

  it("offers no cover for a video", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.upload(screen.getByTestId("source-file"), mp4());
    expect(screen.queryByTestId("source-cover")).toBeNull();
  });
});

describe("the cover's rules", () => {
  const upload = (patch: Partial<StartFormValue>): StartFormValue => ({
    ...EMPTY_START_FORM,
    tab: "upload",
    ...patch,
  });

  it("sends a cover only while a sound-only file is picked", () => {
    expect(picksAudio(upload({ file: mp3() }))).toBe(true);
    expect(picksAudio(upload({ file: mp4() }))).toBe(false);
    expect(picksAudio({ ...upload({ file: mp3() }), tab: "link" })).toBe(false);
    expect(coverToSend(upload({ file: mp3(), cover: png() }))?.name).toBe("cover.png");
    // A cover picked for an audio file that was then swapped for a video.
    expect(coverToSend(upload({ file: mp4(), cover: png() }))).toBeNull();
  });

  it("refuses a cover that is not an image it can use, or too large", () => {
    const gif = new File(["gif"], "cover.gif", { type: "image/gif" });
    expect(validateStartForm(upload({ file: mp3(), cover: gif })).cover).toBe(
      "A cover must be a PNG, JPEG or WebP image.",
    );
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    expect(validateStartForm(upload({ file: mp3(), cover: huge })).cover).toMatch(/at most 10 MB/);
    expect(validateStartForm(upload({ file: mp3(), cover: png() })).cover).toBeUndefined();
    // No cover is fine: it is optional.
    expect(validateStartForm(upload({ file: mp3() })).cover).toBeUndefined();
  });

  it("knows a sound-only file by its type, or by its name when the browser gave no type", () => {
    expect(isAudioFile({ name: "a.mp3", type: "audio/mpeg" })).toBe(true);
    expect(isAudioFile({ name: "a.M4A", type: "" })).toBe(true);
    expect(isAudioFile({ name: "a.wav", type: "application/octet-stream" })).toBe(true);
    expect(isAudioFile({ name: "a.mp4", type: "video/mp4" })).toBe(false);
    expect(isAudioFile({ name: "a.mov", type: "" })).toBe(false);
  });
});
