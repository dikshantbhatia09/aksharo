import { describe, expect, it } from "vitest";

import { uncutClock, type PassItem } from "@montaj/edg";

import { brollAddAt, cutawayForPicture, playingWordsOf } from "./editor-broll";

import type { BrollPicture } from "@/components/broll/use-broll-library";

const WORDS = ["Kal", "hum", "Agra", "gaye", "aur", "Taj", "Mahal", "dekha", "phir", "chai"].map(
  (t, index) => ({ wid: `0:${String(index)}`, t, s: index * 1_000, e: index * 1_000 + 800 }),
);

const PICTURE: BrollPicture = {
  assetId: "01JPX0000000000000000000T1",
  format: "jpeg",
  contentType: "image/jpeg",
  width: 2560,
  height: 1440,
  sizeBytes: 400_000,
  tags: ["taj mahal"],
  title: null,
  source: "upload",
  credit: null,
  url: "https://cdn.test/taj.jpg",
  createdAt: "2026-10-05T09:00:00.000Z",
};

describe("playingWordsOf", () => {
  it("keeps the words that play, in time order", () => {
    const cut = {
      itemId: "01JCVT0000000000000000000A",
      passId: "01JPASS000000000000000000A",
      kind: "cut",
      startMs: 1_000,
      endMs: 2_000,
      payload: {},
      state: "accepted",
    } as PassItem;
    const words = playingWordsOf(
      [...WORDS].reverse().map((word, index) => (index === 0 ? { ...word, deleted: true } : word)),
      [cut],
    );
    expect(words.map((word) => word.t)).toEqual([
      "Kal",
      "Agra",
      "gaye",
      "aur",
      "Taj",
      "Mahal",
      "dekha",
      "phir",
    ]);
  });
});

describe("brollAddAt", () => {
  const clock = uncutClock(30_000);

  it("puts a cutaway on the word under the playhead and the next few", () => {
    const at = brollAddAt({ words: WORDS, playheadMs: 5_300, clock, blocked: [] });
    expect(at).toMatchObject({
      word: "Taj",
      startMs: 5_000,
      window: { startMs: 5_000, endMs: 7_800, startWordId: "0:5", endWordId: "0:7" },
    });
    expect(at).not.toHaveProperty("problem");
  });

  it("says why it cannot: the hook's first seconds, or a title over the words", () => {
    expect(brollAddAt({ words: WORDS, playheadMs: 1_200, clock, blocked: [] })?.problem).toBe(
      "hook",
    );
    expect(
      brollAddAt({
        words: WORDS,
        playheadMs: 5_300,
        clock,
        blocked: [{ startMs: 7_000, endMs: 9_000 }],
      })?.problem,
    ).toBe("title");
    // Past the last word there is nowhere to put one.
    expect(brollAddAt({ words: WORDS, playheadMs: 9_900, clock, blocked: [] })).toBeUndefined();
  });
});

describe("cutawayForPicture", () => {
  it("boxes a wide picture in a tall frame, and names it for the list", () => {
    const window = { startMs: 5_000, endMs: 7_800, startWordId: "0:5", endWordId: "0:7" };
    const cutaway = cutawayForPicture({
      picture: PICTURE,
      window,
      canvas: { width: 1080, height: 1920 },
      index: 2,
      id: "01JBR0000000000000000000A1",
    });
    expect(cutaway).toEqual({
      id: "01JBR0000000000000000000A1",
      kind: "b-roll",
      startMs: 5_000,
      endMs: 7_800,
      image: { assetId: PICTURE.assetId, format: "jpeg", width: 2560, height: 1440 },
      mode: "pip",
      motion: "pull-out",
      startWordId: "0:5",
      endWordId: "0:7",
      label: "taj mahal",
    });
    const full = cutawayForPicture({
      picture: PICTURE,
      window,
      canvas: { width: 1920, height: 1080 },
      index: 0,
    });
    expect(full.mode).toBe("full");
    expect(full.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
