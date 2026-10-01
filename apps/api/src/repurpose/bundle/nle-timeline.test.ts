import { describe, expect, it } from "vitest";

import type { Segment, TranscriptChunk } from "@montaj/edg/schemas";
import type { PassItemTimes } from "@montaj/timemap";

import {
  buildNleTimeline,
  fcpTime,
  frameAtMs,
  frameRateOf,
  msAtFrame,
  readMeText,
  relativeUrl,
  timelineSrt,
  toFcpxml,
  toXmeml,
  xmlText,
  type NleNames,
  type NleTimelineInput,
} from "./nle-timeline.js";

/**
 * "For your editing app" (2026-10-01): the timeline files are the whole
 * feature, so every rule `nle-timeline.ts` states is pinned here - frames,
 * cuts, caption placement, escaping, and that the XML is well formed.
 */

// ---------------------------------------------------------------------------
// A tiny XML 1.0 well-formedness check (no parser is a dependency of the api):
// every tag closes in order, `&` only starts an entity, no raw `<` in text, and
// attributes are quoted.
// ---------------------------------------------------------------------------

function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "").replace(/<!DOCTYPE [a-z]+>\s*/i, "");
  const stack: string[] = [];
  // eslint-disable-next-line security/detect-unsafe-regex -- test-only, over XML this file wrote
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
  let cursor = 0;
  let roots = 0;
  for (const match of body.matchAll(tag)) {
    const text = body.slice(cursor, match.index);
    expect(text, `raw "<" in text before ${match[0]}`).not.toMatch(/</);
    expect(text, "a bare & in text").not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/);
    const [, closing, name = "", attributes = "", selfClosing] = match;
    expect(attributes, "a bare & in an attribute").not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/);
    if (closing === "/") {
      expect(stack.pop(), `</${name}> closes the wrong element`).toBe(name);
    } else if (selfClosing !== "/") {
      if (stack.length === 0) roots += 1;
      stack.push(name);
    } else if (stack.length === 0) {
      roots += 1;
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  expect(body.slice(cursor).trim()).toBe("");
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
  // Nothing that looked like a tag was skipped by the pattern above.
  expect(body.replace(tag, "")).not.toMatch(/</);
}

// ---------------------------------------------------------------------------
// A 10 s clean cut at 30 fps with one accepted cut (2.0-3.0 s) and four captions.
// ---------------------------------------------------------------------------

function word(wid: string, t: string, s: number, e: number): TranscriptChunk["words"][number] {
  return { wid, t, s, e } as TranscriptChunk["words"][number];
}

function segment(
  id: string,
  seq: number,
  from: string,
  to: string,
  startMs: number,
  endMs: number,
): Segment {
  return { id, seq, startWordId: from, endWordId: to, startMs, endMs } as unknown as Segment;
}

const CHUNKS = [
  {
    chunkIdx: 0,
    words: [
      word("w1", "Wait", 0, 700),
      word("w2", "here", 700, 1500),
      word("w3", "gone", 2100, 2900),
      word("w4", "the", 3500, 4200),
      word("w5", "lights", 4200, 5000),
    ],
  },
  {
    chunkIdx: 1,
    words: [word("w6", "दीवाली", 6000, 6500), word("w7", "& <fire>", 6500, 7000)],
  },
] as unknown as TranscriptChunk[];

const SEGMENTS: Segment[] = [
  segment("s1", 0, "w1", "w2", 0, 1500),
  segment("s2", 1, "w3", "w3", 2100, 2900),
  segment("s3", 2, "w4", "w5", 3500, 5000),
  segment("s4", 3, "w6", "w7", 6000, 7000),
];

const CUT: PassItemTimes = { kind: "cut", state: "accepted", startMs: 2000, endMs: 3000 };

function input(overrides: Partial<NleTimelineInput> = {}): NleTimelineInput {
  return {
    durationMs: 10_000,
    fps: 30,
    width: 1080,
    height: 1920,
    hasAudio: true,
    passItems: [CUT],
    segments: SEGMENTS,
    chunks: CHUNKS,
    ...overrides,
  };
}

const NAMES: NleNames = {
  project: "Wait for the lights 9x16",
  event: "Diwali & the ghats",
  mediaFile: "Wait for the lights 9x16.mp4",
};

describe("frame arithmetic", () => {
  it("reads NTSC rates as their true fractions and rounds the rest", () => {
    expect(frameRateOf(29.97002997)).toEqual({ num: 30_000, den: 1001 });
    expect(frameRateOf(23.976)).toEqual({ num: 24_000, den: 1001 });
    expect(frameRateOf(59.94)).toEqual({ num: 60_000, den: 1001 });
    expect(frameRateOf(25)).toEqual({ num: 25, den: 1 });
    expect(frameRateOf(30.02)).toEqual({ num: 30, den: 1 });
    expect(frameRateOf(null)).toEqual({ num: 30, den: 1 });
    expect(frameRateOf(0)).toEqual({ num: 30, den: 1 });
  });

  it("writes FCPXML times as reduced rational seconds", () => {
    expect(fcpTime(0, { num: 30, den: 1 })).toBe("0s");
    expect(fcpTime(1, { num: 30, den: 1 })).toBe("1/30s");
    expect(fcpTime(60, { num: 30, den: 1 })).toBe("2s");
    expect(fcpTime(105, { num: 30, den: 1 })).toBe("7/2s");
    expect(fcpTime(1, { num: 30_000, den: 1001 })).toBe("1001/30000s");
    expect(fcpTime(30, { num: 30_000, den: 1001 })).toBe("1001/1000s");
    expect(fcpTime(3, { num: 25, den: 1 })).toBe("3/25s");
  });

  it("goes between milliseconds and frames without drift at 29.97", () => {
    const ntsc = frameRateOf(29.97);
    // 60 seconds of NTSC video is 1798.2 frames: the nearest is 1798.
    expect(frameAtMs(60_000, ntsc)).toBe(1798);
    // A frame boundary survives the round trip at every frame of a minute.
    for (let frame = 0; frame < 1800; frame += 1) {
      expect(frameAtMs(msAtFrame(frame, ntsc), ntsc)).toBe(frame);
    }
  });
});

describe("buildNleTimeline", () => {
  it("repeats the document's accepted cuts as back-to-back stretches of the clean cut", () => {
    const timeline = buildNleTimeline(input());
    expect(timeline.sourceFrames).toBe(300);
    expect(timeline.items).toEqual([
      { sourceStart: 0, duration: 60, offset: 0 },
      { sourceStart: 90, duration: 210, offset: 60 },
    ]);
    expect(timeline.frames).toBe(270);
  });

  it("places every caption on the timeline's clock and leaves out one whose words were cut", () => {
    const timeline = buildNleTimeline(input());
    expect(timeline.captions).toEqual([
      { start: 0, end: 45, text: "Wait here", item: 0 },
      // 3.5-5.0 s of the clean cut, one second after the cut: 75-120 on the timeline.
      { start: 75, end: 120, text: "the lights", item: 1 },
      { start: 150, end: 180, text: "दीवाली & <fire>", item: 1 },
    ]);
  });

  it("ignores cuts that are only proposed, and other kinds of item", () => {
    const timeline = buildNleTimeline(
      input({
        passItems: [
          { ...CUT, state: "proposed" },
          { kind: "zoom", state: "accepted", startMs: 0, endMs: 5000 } as PassItemTimes,
        ],
      }),
    );
    expect(timeline.items).toEqual([{ sourceStart: 0, duration: 300, offset: 0 }]);
    expect(timeline.captions.map((caption) => caption.text)).toContain("gone");
  });

  it("never lets two captions overlap, and keeps hidden ones out", () => {
    const timeline = buildNleTimeline(
      input({
        passItems: [],
        segments: [
          segment("a", 0, "w1", "w2", 0, 2000),
          segment("b", 1, "w3", "w3", 1500, 2900),
          { ...segment("c", 2, "w4", "w5", 3500, 5000), hidden: true } as Segment,
        ],
      }),
    );
    expect(timeline.captions).toEqual([
      { start: 0, end: 45, text: "Wait here", item: 0 },
      { start: 45, end: 87, text: "gone", item: 0 },
    ]);
  });

  it("counts frames at the clean cut's NTSC rate", () => {
    const timeline = buildNleTimeline(input({ fps: 29.97, passItems: [] }));
    expect(timeline.rate).toEqual({ num: 30_000, den: 1001 });
    expect(timeline.sourceFrames).toBe(300);
    // 3.5 s at 29.97 is frame 104.895: 105.
    expect(timeline.captions[2]?.start).toBe(105);
  });
});

describe("toFcpxml", () => {
  it("is well-formed FCPXML 1.9 with the clip on the spine and titles connected above it", () => {
    const xml = toFcpxml(buildNleTimeline(input()), NAMES);
    assertWellFormed(xml);
    expect(xml).toContain('<fcpxml version="1.9">');
    expect(xml).toContain('frameDuration="1/30s" width="1080" height="1920"');
    expect(xml).toContain('src="./Wait%20for%20the%20lights%209x16.mp4"');
    expect(xml).toContain('<sequence format="r1" duration="9s"');
    // The two kept stretches, back to back.
    expect(xml).toContain('offset="0s" start="0s" duration="2s"');
    expect(xml).toContain('offset="2s" start="3s" duration="7s"');
    // "the lights": on the second stretch's own clock (it starts at 3 s of the
    // clean cut), 0.5 s in, for 1.5 s.
    expect(xml).toMatch(
      /<title ref="r3" lane="1" name="the lights" offset="7\/2s" start="3600s" duration="3\/2s">/,
    );
    expect(xml.match(/<title /g)).toHaveLength(3);
  });

  it("escapes caption text and keeps Hindi as typed", () => {
    const xml = toFcpxml(buildNleTimeline(input()), NAMES);
    expect(xml).toContain("दीवाली &amp; &lt;fire&gt;");
    expect(xml).not.toContain("<fire>");
    expect(xml).toContain('<event name="Diwali &amp; the ghats">');
  });

  it("writes NTSC frame durations", () => {
    const xml = toFcpxml(buildNleTimeline(input({ fps: 29.97, passItems: [] })), NAMES);
    assertWellFormed(xml);
    expect(xml).toContain('frameDuration="1001/30000s"');
    // 300 frames of 1001/30000 s.
    expect(xml).toContain('duration="1001/100s"');
  });

  it("leaves the sound out of a clip with none", () => {
    const xml = toFcpxml(buildNleTimeline(input({ hasAudio: false })), NAMES);
    assertWellFormed(xml);
    expect(xml).not.toContain("hasAudio");
    expect(xml).not.toContain("audioLayout");
  });
});

describe("toXmeml", () => {
  it("is well-formed xmeml 4 with each stretch on V1 and A1, in frames", () => {
    const xml = toXmeml(buildNleTimeline(input()), NAMES);
    assertWellFormed(xml);
    expect(xml).toContain('<xmeml version="4">');
    expect(xml).toContain("<duration>270</duration>");
    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<ntsc>FALSE</ntsc>");
    expect(xml.match(/<clipitem id="clipitem-v/g)).toHaveLength(2);
    expect(xml.match(/<clipitem id="clipitem-a/g)).toHaveLength(2);
    expect(xml).toMatch(/<start>60<\/start>\s*<end>270<\/end>\s*<in>90<\/in>\s*<out>300<\/out>/);
    // The file is described once and referred to after that.
    expect(xml.match(/<file id="file-1">/g)).toHaveLength(1);
    expect(xml.match(/<file id="file-1"\/>/g)).toHaveLength(3);
    expect(xml).toContain("<pathurl>./Wait%20for%20the%20lights%209x16.mp4</pathurl>");
  });

  it("marks NTSC with a rounded timebase, and has no audio track without sound", () => {
    const xml = toXmeml(buildNleTimeline(input({ fps: 29.97, hasAudio: false })), NAMES);
    assertWellFormed(xml);
    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<ntsc>TRUE</ntsc>");
    expect(xml).not.toContain("<audio>");
  });

  it("escapes the names it writes", () => {
    const xml = toXmeml(buildNleTimeline(input()), {
      ...NAMES,
      project: `Tom & Jerry's "<best>"`,
    });
    assertWellFormed(xml);
    expect(xml).toContain("<name>Tom &amp; Jerry&apos;s &quot;&lt;best&gt;&quot;</name>");
  });
});

describe("timelineSrt", () => {
  it("writes the captions on the timeline's clock, frame-exact", () => {
    const srt = timelineSrt(buildNleTimeline(input()));
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nWait here");
    expect(srt).toContain("2\n00:00:02,500 --> 00:00:04,000\nthe lights");
    expect(srt).toContain("3\n00:00:05,000 --> 00:00:06,000\nदीवाली & <fire>");
    expect(srt).not.toContain("gone");
  });
});

describe("text helpers", () => {
  it("escapes the five markup characters and drops what XML 1.0 cannot hold", () => {
    expect(xmlText(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
    expect(xmlText("bell\u0007 tab\t line\n")).toBe("bell tab\t line\n");
    expect(xmlText("lone \ud800 surrogate")).toBe("lone  surrogate");
    expect(xmlText("emoji 🎆 stays")).toBe("emoji 🎆 stays");
    expect(xmlText("हिंदी")).toBe("हिंदी");
  });

  it("makes a relative URL of a file name", () => {
    expect(relativeUrl("Clip 9x16.mp4")).toBe("./Clip%209x16.mp4");
    expect(relativeUrl("दीवाली.mp4")).toBe(`./${encodeURIComponent("दीवाली")}.mp4`);
  });

  it("names every file in the read-me", () => {
    const text = readMeText(NAMES, { fcpxml: "a.fcpxml", xmeml: "a Premiere.xml", srt: "a.srt" });
    for (const name of [NAMES.mediaFile, "a.fcpxml", "a Premiere.xml", "a.srt"]) {
      expect(text).toContain(name);
    }
  });
});
