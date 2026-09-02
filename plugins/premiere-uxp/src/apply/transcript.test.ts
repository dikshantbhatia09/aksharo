import { describe, expect, it } from "vitest";

import { buildTranscriptSegments, injectTranscript } from "./transcript.js";
import { MockPremiereHost } from "../host/premiere.js";

import type { EdgSegmentLike } from "./types.js";

const segments: EdgSegmentLike[] = [
  {
    id: "seg-1",
    seq: "a0",
    startFrames: 0,
    endFrames: 50,
    speaker: "Speaker A",
    words: [
      { wid: "0:0", t: "hello", startFrames: 0, endFrames: 10 },
      { wid: "0:1", t: "world", startFrames: 10, endFrames: 20, deleted: true },
    ],
  },
  { id: "seg-2", seq: "a1", startFrames: 50, endFrames: 100, hidden: true, words: [] },
];

describe("buildTranscriptSegments", () => {
  it("drops hidden segments and deleted words", () => {
    const result = buildTranscriptSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0]?.segmentId).toBe("seg-1");
    expect(result[0]?.speaker).toBe("Speaker A");
    expect(result[0]?.words).toEqual([
      { wid: "0:0", text: "hello", startFrames: 0, endFrames: 10 },
    ]);
  });
});

describe("injectTranscript", () => {
  it("imports the built segments and is idempotent on re-import", async () => {
    const host = new MockPremiereHost();
    const input = {
      sequenceId: "seq-mock-1",
      language: "en",
      range: { startFrames: 0, endFrames: 100 },
      segments,
    };

    const first = await injectTranscript(host, input);
    expect(first.replacedExisting).toBe(false);

    const second = await injectTranscript(host, input);
    expect(second.replacedExisting).toBe(true);
  });
});
