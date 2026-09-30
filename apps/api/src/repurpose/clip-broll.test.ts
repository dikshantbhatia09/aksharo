import { describe, expect, it } from "vitest";

import { BROLL_RULES, stableOverlayId, uncutClock } from "@montaj/edg";
import type { PassItem, TranscriptChunk, WordId } from "@montaj/edg/schemas";
import { BrollRequestSchema } from "@montaj/repurpose-contracts";
import { fromAcceptedItems } from "@montaj/timemap";

import {
  brollAvoidSpans,
  brollOverlayFor,
  brollPlan,
  brollRequestOf,
  orientationOf,
  playingWords,
  proposalsFrom,
  type ClipWord,
} from "./clip-broll.js";
import { spokenTags, type LibraryPicture } from "../broll/broll-match.js";

/** Forty words, one every half second: "w0" ... with a few named things. */
const TEXT = [
  "Kal",
  "hum",
  "Agra",
  "gaye",
  "aur",
  "wahan",
  "sabse",
  "pehle",
  "Taj",
  "Mahal",
  "dekha",
  "phir",
  "bazaar",
  "mein",
  "masala",
  "chai",
  "pi",
  "aur",
  "petha",
  "khaya",
  "shaam",
  "ko",
  "Yamuna",
  "ke",
  "kinare",
  "baithe",
  "aur",
  "suraj",
  "dhalte",
  "dekha",
  "raat",
  "ko",
  "train",
  "pakdi",
  "aur",
  "ghar",
  "wapas",
  "aa",
  "gaye",
  "bas",
];
const WORDS: ClipWord[] = TEXT.map((t, index) => ({
  wid: `0:${String(index)}`,
  t,
  s: index * 500,
  e: index * 500 + 400,
}));
const CHUNKS: TranscriptChunk[] = [
  {
    chunkIdx: 0,
    startMs: 0,
    endMs: 20_000,
    words: WORDS.map((word) => ({ ...word, wid: word.wid as WordId })),
  },
];
const CANVAS = { width: 1080, height: 1920 };

const picture = (id: string, tags: string[], width = 1440, height = 2560): LibraryPicture => ({
  id,
  tags,
  title: null,
  width,
  height,
  format: "jpeg",
});
const TAJ = picture("01JPX0000000000000000000T1", ["taj mahal"]);
const CHAI = picture("01JPX0000000000000000000C1", ["masala chai"], 2560, 1440);

function cut(startMs: number, endMs: number, state: PassItem["state"] = "accepted"): PassItem {
  return {
    itemId: `01JCVT${String(startMs).padStart(20, "0")}`,
    passId: "01JPASS0000000000000000000",
    kind: "cut",
    startMs,
    endMs,
    payload: {},
    state,
  } as PassItem;
}

describe("playingWords", () => {
  it("leaves out the words an accepted cut takes, and deleted ones", () => {
    const chunks: TranscriptChunk[] = [
      {
        ...CHUNKS[0]!,
        words: CHUNKS[0]!.words.map((word, index) =>
          index === 1 ? { ...word, deleted: true } : word,
        ),
      },
    ];
    const words = playingWords(chunks, [cut(1_000, 2_000), cut(3_000, 4_000, "proposed")]);
    expect(words.map((word) => word.wid).slice(0, 6)).toEqual([
      "0:0",
      "0:4",
      "0:5",
      "0:6",
      "0:7",
      "0:8",
    ]);
  });
});

describe("brollAvoidSpans", () => {
  it("keeps the hook's first seconds and the last seconds, as the video plays, and every title", () => {
    const clock = fromAcceptedItems([cut(1_000, 2_000)], { sourceDurationMs: 20_000 });
    const spans = brollAvoidSpans({
      toSource: (ms) => clock.toSource(ms),
      outputDurationMs: clock.outputDurationMs,
      sourceDurationMs: 20_000,
      blocked: [{ startMs: 0, endMs: 2_500 }],
    });
    // A second cut out at 1-2 s: the hook's first 3 s of video end at 4 s of source.
    expect(spans).toEqual([
      { startMs: 0, endMs: 4_000 },
      { startMs: 17_000, endMs: 20_000 },
      { startMs: 0, endMs: 2_500 },
    ]);
  });
});

describe("brollRequestOf", () => {
  it("asks about the words that play, within the contract's bounds", () => {
    const request = brollRequestOf({
      words: WORDS,
      language: "hi-Latn",
      title: `  ${"A day in Agra ".repeat(20)}`,
      avoid: [{ startMs: 0, endMs: 3_000 }],
    });
    expect(BrollRequestSchema.safeParse(request).success).toBe(true);
    expect(request.words).toHaveLength(40);
    expect(request.words[8]).toEqual({ id: "0:8", t: "Taj", s: 4_000, e: 4_400 });
    expect(request.minGapMs).toBe(BROLL_RULES.minGapMs);
    expect(request.title?.length).toBeLessThanOrEqual(160);
  });
});

describe("proposalsFrom", () => {
  it("puts the model's moments first and drops a spoken tag a moment already covers", () => {
    const tagged = spokenTags(WORDS, [TAJ, CHAI]);
    const proposals = proposalsFrom(
      [
        {
          startWordId: "0:8",
          endWordId: "0:9",
          startMs: 4_000,
          endMs: 4_900,
          phrase: "taj mahal at sunrise",
          spoken: "Taj Mahal",
          score: 9,
        },
      ],
      tagged,
      WORDS,
    );
    expect(proposals.map((proposal) => [proposal.phrase, proposal.pictureId])).toEqual([
      ["taj mahal at sunrise", undefined],
      ["masala chai", CHAI.id],
    ]);
    expect(proposals[1]?.spoken).toBe("masala chai");
  });
});

describe("brollPlan", () => {
  const moment = (from: number, to: number, phrase: string, score = 8) => ({
    startWordId: `0:${String(from)}`,
    endWordId: `0:${String(to)}`,
    score,
    phrase,
    spoken: TEXT.slice(from, to + 1).join(" "),
  });

  it("keeps only moments a library picture can fill when stock photos are off", () => {
    const plan = brollPlan({
      proposals: [moment(8, 9, "taj mahal"), moment(22, 22, "yamuna river", 9)],
      pictures: [TAJ],
      words: WORDS,
      clock: uncutClock(40_000),
      blocked: [],
      canvas: CANVAS,
      stockEnabled: false,
    });
    expect(plan.map((entry) => [entry.proposal.phrase, entry.picture?.id])).toEqual([
      ["taj mahal", TAJ.id],
    ]);
  });

  it("keeps one for a stock photo to fill when stock photos are on, with no picture yet", () => {
    const plan = brollPlan({
      proposals: [moment(8, 9, "taj mahal"), moment(22, 22, "yamuna river", 9)],
      pictures: [TAJ],
      words: WORDS,
      clock: uncutClock(40_000),
      blocked: [],
      canvas: CANVAS,
      stockEnabled: true,
    });
    expect(plan.map((entry) => [entry.proposal.phrase, entry.picture?.id])).toEqual([
      ["taj mahal", TAJ.id],
      ["yamuna river", undefined],
    ]);
  });

  it("does not show one picture twice when another fits as well", () => {
    const twin = picture("01JPX0000000000000000000T2", ["taj mahal"]);
    const plan = brollPlan({
      proposals: [moment(8, 9, "taj mahal"), moment(28, 29, "taj mahal")],
      pictures: [TAJ, twin],
      words: WORDS,
      clock: uncutClock(40_000),
      blocked: [],
      canvas: CANVAS,
      stockEnabled: false,
    });
    expect(new Set(plan.map((entry) => entry.picture?.id)).size).toBe(plan.length);
  });
});

describe("brollOverlayFor", () => {
  it("is the shape's own cutaway, boxed when its picture's shape would not fill the frame", () => {
    const planned = {
      startMs: 7_000,
      endMs: 9_400,
      startWordId: "0:14",
      endWordId: "0:18",
      proposal: 0,
    };
    const proposal = {
      startWordId: "0:14",
      endWordId: "0:15",
      score: 7,
      phrase: "masala chai",
      spoken: "",
    };
    const overlay = brollOverlayFor({
      variantId: "01JVAR0000000000000000000A",
      index: 1,
      planned,
      proposal,
      picture: CHAI,
      canvas: CANVAS,
    });
    expect(overlay).toEqual({
      id: stableOverlayId("01JVAR0000000000000000000A:broll:1"),
      kind: "b-roll",
      startMs: 7_000,
      endMs: 9_400,
      image: { assetId: CHAI.id, format: "jpeg", width: 2560, height: 1440 },
      mode: "pip",
      motion: "pan-left",
      startWordId: "0:14",
      endWordId: "0:18",
      label: "masala chai",
    });
    expect(orientationOf(CANVAS)).toBe("portrait");
    expect(orientationOf({ width: 1920, height: 1080 })).toBe("landscape");
    expect(orientationOf({ width: 1080, height: 1080 })).toBe("square");
  });
});
