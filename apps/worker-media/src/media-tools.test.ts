import { describe, expect, it } from "vitest";

import { MediaToolsMissingError, REQUIRED_TOOLS, toolVersion } from "./media-tools.js";

describe("MediaToolsMissingError", () => {
  it("names the missing binaries and how to install them", () => {
    const error = new MediaToolsMissingError(["ffprobe"]);
    expect(error.message).toContain("ffprobe is not on PATH");
    expect(error.message).toContain("winget install");
    expect(error.message).toContain("brew install ffmpeg");
    expect(error.message).toContain("apt-get install");
    expect(error.missing).toEqual(["ffprobe"]);
  });

  it("reads correctly when both binaries are missing", () => {
    expect(new MediaToolsMissingError(["ffmpeg", "ffprobe"]).message).toContain(
      "ffmpeg and ffprobe are not on PATH",
    );
  });
});

describe("REQUIRED_TOOLS", () => {
  it("is exactly ffmpeg and ffprobe", () => {
    expect(REQUIRED_TOOLS).toEqual(["ffmpeg", "ffprobe"]);
  });
});

describe("toolVersion", () => {
  it("returns null instead of throwing when a binary is absent", async () => {
    // `toolVersion` is typed to the required tools; the cast probes a name that
    // cannot exist so the check stays hermetic on machines that do have FFmpeg.
    const missing = "montaj-no-such-binary" as unknown as (typeof REQUIRED_TOOLS)[number];
    await expect(toolVersion(missing)).resolves.toBeNull();
  });
});
