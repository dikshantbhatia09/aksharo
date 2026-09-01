import { describe, expect, it } from "vitest";

import { type TranscriptChunk } from "./schemas/transcript.js";
import {
  buildWordIndex,
  TranscriptIndexError,
  wordPositions,
  wordsBetween,
} from "./transcript-index.js";

function chunk(
  chunkIdx: number,
  startMs: number,
  words: [n: number, text: string, deleted?: boolean][],
): TranscriptChunk {
  return {
    chunkIdx,
    startMs,
    endMs: startMs + 600_000,
    words: words.map(([n, text, deleted], i) => ({
      wid: `${chunkIdx}:${n}`,
      s: startMs + i * 400,
      e: startMs + i * 400 + 300,
      t: text,
      ...(deleted === true ? { deleted: true } : {}),
    })),
  } as TranscriptChunk;
}

const chunks: TranscriptChunk[] = [
  chunk(1, 600_000, [
    [0, "phir"],
    [1, "cut"],
    [2, "lagao"],
  ]),
  chunk(0, 0, [
    [0, "bhai"],
    [1, "aaj"],
    [3, "editing", true],
    [2, "hum"],
  ]),
];

describe("buildWordIndex", () => {
  it("orders chunks by index and keeps document order inside a chunk", () => {
    const index = buildWordIndex(chunks);
    expect([...index.keys()]).toEqual(["0:0", "0:1", "0:3", "0:2", "1:0", "1:1", "1:2"]);
  });

  it("records the chunk and the chunk-relative offset", () => {
    const index = buildWordIndex(chunks);
    expect(index.get("1:1")).toMatchObject({ chunkIdx: 1, offsetMs: 400, t: "cut" });
    expect(index.get("0:1")).toMatchObject({ chunkIdx: 0, offsetMs: 400 });
  });

  it("rejects a reused word id", () => {
    expect(() => buildWordIndex([chunk(0, 0, [[0, "a"]]), chunk(0, 0, [[0, "b"]])])).toThrow(
      TranscriptIndexError,
    );
  });

  it("numbers positions in document order", () => {
    const positions = wordPositions(buildWordIndex(chunks));
    // "0:3" was inserted after "0:1", so its position is lower than "0:2" even
    // though its number is higher — id order is not document order (D28).
    expect(positions.get("0:3")).toBe(2);
    expect(positions.get("0:2")).toBe(3);
  });
});

describe("wordsBetween", () => {
  const index = buildWordIndex(chunks);

  it("returns the inclusive range in document order", () => {
    expect(wordsBetween(index, "0:1", "1:0").map((word) => word.t)).toEqual(["aaj", "hum", "phir"]);
  });

  it("drops tombstones unless asked for them", () => {
    expect(
      wordsBetween(index, "0:0", "0:2", { includeDeleted: true }).map((word) => word.t),
    ).toEqual(["bhai", "aaj", "editing", "hum"]);
  });

  it("returns a single word when both ends are the same", () => {
    expect(wordsBetween(index, "1:2", "1:2").map((word) => word.t)).toEqual(["lagao"]);
  });

  it("rejects unknown ids and backwards ranges", () => {
    expect(() => wordsBetween(index, "9:9", "1:0")).toThrow(/unknown word id/);
    expect(() => wordsBetween(index, "0:0", "not-a-word-id")).toThrow(/unknown word id/);
    expect(() => wordsBetween(index, "1:0", "0:0")).toThrow(/runs backwards/);
  });
});
