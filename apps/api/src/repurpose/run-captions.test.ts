import { describe, expect, it } from "vitest";

import { bulkRunsSchema, watchSetupSchema } from "./automations/source-watch.dto.js";
import { createRunSchema, runCaptionsSetupSchema } from "./repurpose.dto.js";
import { runDefaultsSetupSchema } from "./results/run-results.dto.js";
import { captionsLanguageOf, runCaptionsOf } from "./run-captions.js";
import { cuesInWindow, parseSidecar } from "../media/import/import-align-params.js";
import { IMPORT_MAX_BYTES } from "../projects/projects.constants.js";

/** A clips run started with captions the person already has (2026-10-01). */

const SETUP = {
  sourceLanguage: "auto",
  caption: { styleId: "punch-pop" },
  discovery: { mode: "ai", requestedCandidates: 5 },
};
const FILE = { from: "file", kind: "srt", content: "1\n00:00:00,000 --> 00:00:01,000\nhi\n" };

describe("runCaptionsOf", () => {
  it("reads what the run froze, and nothing from a run without captions", () => {
    expect(
      runCaptionsOf({
        config: { captions: { subtitleMediaId: "01SUB", kind: "vtt", cueCount: 4, from: "url" } },
      }),
    ).toEqual({ subtitleMediaId: "01SUB", kind: "vtt", cueCount: 4, from: "url" });
    expect(runCaptionsOf({ config: { automation: "auto" } })).toBeNull();
    expect(runCaptionsOf({ config: null })).toBeNull();
    expect(
      runCaptionsOf({ config: { captions: { subtitleMediaId: "01SUB", kind: "ass" } } }),
    ).toBeNull();
  });
});

describe("captionsLanguageOf", () => {
  it("keeps a picked language and reads the script when asked to detect", () => {
    expect(captionsLanguageOf("hi-Latn", [{ text: "hello" }])).toBe("hi-Latn");
    expect(captionsLanguageOf("auto", [{ text: "hello" }])).toBe("en");
    expect(captionsLanguageOf("auto", [{ text: "hello" }, { text: "नमस्ते" }])).toBe("hi");
    expect(captionsLanguageOf(null, [{ text: "hello" }])).toBe("en");
  });
});

describe("cuesInWindow", () => {
  const cues = [
    { startMs: 0, endMs: 1_000 },
    { startMs: 59_000, endMs: 61_000 },
    { startMs: 70_000, endMs: 71_000 },
    { startMs: 125_000, endMs: 126_000 },
  ];

  it("keeps every cue with no window", () => {
    expect(cuesInWindow(cues, { startMs: 0, endMs: null })).toEqual(cues);
  });

  it("drops cues outside the window, moves the rest onto its clock and cuts them at its edges", () => {
    expect(cuesInWindow(cues, { startMs: 60_000, endMs: 120_000 })).toEqual([
      { startMs: 0, endMs: 1_000 },
      { startMs: 10_000, endMs: 11_000 },
    ]);
  });
});

describe("parseSidecar", () => {
  it("reads what the import writes and refuses anything else", () => {
    const stored = {
      version: 1,
      kind: "srt",
      timed: true,
      language: "en",
      alignsMediaId: null,
      sourceUrl: null,
      importedAt: "2026-10-01T00:00:00.000Z",
      cues: [{ index: 1, startMs: 0, endMs: 1_000, text: "hi" }],
    };
    expect(parseSidecar(JSON.stringify(stored))).toMatchObject({ kind: "srt", cues: stored.cues });
    expect(parseSidecar("nope")).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...stored, version: 2 }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...stored, cues: [{ text: "hi" }] }))).toBeNull();
  });
});

describe("the captions a run may be started with", () => {
  it("takes an SRT or VTT file, or a link to one", () => {
    expect(runCaptionsSetupSchema.safeParse(FILE).success).toBe(true);
    expect(runCaptionsSetupSchema.safeParse({ ...FILE, kind: "vtt" }).success).toBe(true);
    expect(
      runCaptionsSetupSchema.safeParse({ from: "url", url: "https://example.com/a.srt" }).success,
    ).toBe(true);
    expect(
      createRunSchema.safeParse({
        source: {
          kind: "url",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsAttested: true,
        },
        setup: { ...SETUP, captions: FILE },
      }).success,
    ).toBe(true);
  });

  it("refuses other formats, empty or oversized files, and links that are not web addresses", () => {
    expect(runCaptionsSetupSchema.safeParse({ ...FILE, kind: "ass" }).success).toBe(false);
    expect(runCaptionsSetupSchema.safeParse({ ...FILE, content: "" }).success).toBe(false);
    expect(
      runCaptionsSetupSchema.safeParse({ ...FILE, content: "x".repeat(IMPORT_MAX_BYTES + 1) })
        .success,
    ).toBe(false);
    expect(
      runCaptionsSetupSchema.safeParse({ from: "url", url: "file:///etc/passwd" }).success,
    ).toBe(false);
  });

  it("belongs to one video: never a saved default, a channel's setup or several links'", () => {
    const parsed = runDefaultsSetupSchema.parse({ ...SETUP, captions: FILE });
    expect(parsed).not.toHaveProperty("captions");
    expect(
      watchSetupSchema.safeParse({ ...SETUP, automation: "auto", captions: FILE }).success,
    ).toBe(false);
    expect(
      bulkRunsSchema.safeParse({
        links: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
        setup: { ...SETUP, captions: FILE },
        rightsAttested: true,
      }).success,
    ).toBe(false);
  });
});
