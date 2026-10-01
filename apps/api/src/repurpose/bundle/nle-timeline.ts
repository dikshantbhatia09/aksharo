import type { Segment, TranscriptChunk } from "@montaj/edg/schemas";
import { fromAcceptedItems, type PassItemTimes } from "@montaj/timemap";

import { toCues, toSrt, type Cue } from "../../transcripts/transcript-export.js";

/**
 * "For your editing app" (2026-10-01, OpusClip parity wave 3): a clip's edit as
 * timeline files a desktop editor opens, written from the clip's own editing
 * document. Pure: no I/O, so every frame of it is tested on its own
 * (`nle-timeline.test.ts`) and the service only reads rows and streams the ZIP.
 *
 * **What the timeline holds.** The clip's clean cut (no captions burned in) is
 * the one picture file. The finishing pass and the person's own edits remove
 * source time with accepted `cut` items; the timeline repeats those cuts, so
 * what opens in Premiere or Final Cut plays exactly like the captioned video
 * Aksharo made: one clip item per kept stretch of the clean cut, back to back.
 * A clip with no cuts is a single item. Every caption is placed on that
 * timeline's clock (the "output" clock of `@montaj/timemap`), not the clean
 * cut's own, so the SRT and the titles line up with the timeline they come
 * with - and a caption whose every word was cut is left out, as the render
 * leaves it out.
 *
 * **Exact to frames.** Everything is counted in whole frames at the clean cut's
 * own rate (`media_assets.fps`), with the NTSC rates (23.976, 29.97, 59.94) as
 * their true fractions (24000/1001 ...), because both formats write time as
 * frames and a millisecond rounded twice drifts a frame by the end of a minute.
 * A cut's edges snap to the nearest frame; a caption's start and end snap the
 * same way, never overlap the next caption (an editor stacks overlapping titles
 * on new lanes), and last at least one frame.
 *
 * **Two timeline files, one per family of editor:**
 *
 * - **FCPXML 1.9** (`.fcpxml`): Final Cut Pro 10.5+ (File > Import > XML) and
 *   DaVinci Resolve 17+ (File > Import > Timeline) import it. The kept stretches are `asset-clip`s on the primary storyline;
 *   each caption is a Basic Title connected above the stretch it starts in
 *   (lane 1), so it moves with that stretch if the person trims.
 * - **Final Cut Pro 7 XML** (`xmeml` version 4, `.xml`): what Premiere Pro's
 *   File > Import reads. The picture on V1 and its sound on A1; captions come
 *   in through the `.srt` (Premiere's own caption track), because xmeml titles
 *   import into Premiere as legacy titles nobody can edit any more.
 *
 * **Where the video is.** The clean cut sits in the same folder as the
 * timelines, but neither format can say "the file next to me" in a way every
 * editor reads, and Aksharo cannot know the folder the person unzips to. So
 * each timeline names the file by an absolute `file:` URL with the clip's own
 * file name at the root of the disk (`mediaFileUrl`), which every editor reads
 * as "a file that has moved" and offers to relink:
 *
 * - FCPXML: Apple's reference allows a relative `src` only inside an `.fcpxmld`
 *   bundle (FCPXML 1.10+); outside one Final Cut Pro wants an absolute URL and
 *   may refuse the whole import over a relative one. An absolute URL to a
 *   missing file imports as an offline clip, relinked with File > Relink
 *   Files. Resolve reads the same file and asks for the folder of a clip it
 *   cannot find. (No bundle: Resolve does not open `.fcpxmld`, and a ZIP
 *   unpacked on Windows loses the bundle anyway.)
 * - xmeml: Final Cut Pro 7 wrote `file://localhost/...`, the form Premiere's
 *   importer expects; a missing file opens its Link Media window.
 *
 * "Read me.txt" walks through the import and the relink in each app, menu by
 * menu. The XML is UTF-8 with every caption escaped (`& < > " '`) and stripped
 * of characters XML 1.0 cannot carry, so Hindi and Hinglish captions arrive as
 * they were typed.
 */

/** A frame rate as an exact fraction: `num / den` frames a second. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** When a clean cut's rate was never measured: what every clip is cut at. */
export const DEFAULT_FRAME_RATE: FrameRate = { num: 30, den: 1 };

/** The NTSC rates, as the fractions editors expect. */
const NTSC: readonly { readonly nominal: number; readonly rate: FrameRate }[] = [
  { nominal: 24, rate: { num: 24_000, den: 1001 } },
  { nominal: 30, rate: { num: 30_000, den: 1001 } },
  { nominal: 60, rate: { num: 60_000, den: 1001 } },
];

/**
 * The probe's measured rate (a float such as `29.97002997`) as a fraction:
 * within 0.01 of an NTSC rate it is that rate, else the nearest whole number.
 */
export function frameRateOf(fps: number | null | undefined): FrameRate {
  if (fps === null || fps === undefined || !Number.isFinite(fps) || fps <= 0 || fps > 240) {
    return DEFAULT_FRAME_RATE;
  }
  for (const { rate } of NTSC) {
    if (Math.abs(fps - rate.num / rate.den) < 0.01) return rate;
  }
  return { num: Math.max(1, Math.round(fps)), den: 1 };
}

/** Whether a rate is one of the NTSC fractions (xmeml says so with `<ntsc>`). */
export function isNtsc(rate: FrameRate): boolean {
  return rate.den === 1001;
}

/** The whole-number rate an editor counts timecode in (30 for 29.97). */
export function timebaseOf(rate: FrameRate): number {
  return Math.round(rate.num / rate.den);
}

/** The frame nearest a millisecond. */
export function frameAtMs(ms: number, rate: FrameRate): number {
  return Math.max(0, Math.round((ms * rate.num) / (rate.den * 1000)));
}

/** A frame's start in milliseconds, rounded to the nearest one (for SRT). */
export function msAtFrame(frame: number, rate: FrameRate): number {
  return Math.round((frame * rate.den * 1000) / rate.num);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x === 0 ? 1 : x;
}

/** FCPXML time: frames as a reduced rational number of seconds (`1001/30000s`, `2s`, `0s`). */
export function fcpTime(frames: number, rate: FrameRate): string {
  if (frames === 0) return "0s";
  const numerator = frames * rate.den;
  const divisor = gcd(numerator, rate.num);
  const top = numerator / divisor;
  const bottom = rate.num / divisor;
  return bottom === 1 ? `${String(top)}s` : `${String(top)}/${String(bottom)}s`;
}

/** One kept stretch of the clean cut, placed on the timeline (all in frames). */
export interface TimelineItem {
  /** First frame of the clean cut it plays. */
  readonly sourceStart: number;
  /** Frames it plays for. */
  readonly duration: number;
  /** Where on the timeline it starts. */
  readonly offset: number;
}

/** One caption on the timeline (frames), with its text. */
export interface TimelineCaption {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** The timeline item it starts in: a title is connected to that one. */
  readonly item: number;
}

export interface NleTimeline {
  readonly rate: FrameRate;
  readonly width: number;
  readonly height: number;
  readonly hasAudio: boolean;
  /** Frames of the clean cut. */
  readonly sourceFrames: number;
  /** Frames of the timeline: the kept stretches added up. */
  readonly frames: number;
  readonly items: readonly TimelineItem[];
  readonly captions: readonly TimelineCaption[];
}

export interface NleTimelineInput {
  readonly durationMs: number;
  readonly fps: number | null | undefined;
  readonly width: number;
  readonly height: number;
  readonly hasAudio: boolean;
  /** Every pass item of the clip's document: only accepted cuts move the timeline. */
  readonly passItems: readonly PassItemTimes[];
  /** The document's captions, in `seq` order. */
  readonly segments: readonly Segment[];
  readonly chunks: readonly TranscriptChunk[];
}

/**
 * The clip's timeline: its kept stretches, frame-snapped, and every caption
 * still shown, on the timeline's clock.
 */
export function buildNleTimeline(input: NleTimelineInput): NleTimeline {
  const rate = frameRateOf(input.fps);
  const durationMs = Math.max(0, Math.round(input.durationMs));
  const sourceFrames = frameAtMs(durationMs, rate);
  const timeMap = fromAcceptedItems(input.passItems, { sourceDurationMs: durationMs });

  // The kept stretches: the clean cut minus the merged cuts, edges on frames.
  const items: TimelineItem[] = [];
  let cursor = 0;
  let offset = 0;
  const keep = (fromFrame: number, toFrame: number): void => {
    const start = Math.min(Math.max(fromFrame, 0), sourceFrames);
    const end = Math.min(Math.max(toFrame, 0), sourceFrames);
    if (end <= start) return;
    items.push({ sourceStart: start, duration: end - start, offset });
    offset += end - start;
  };
  for (const cut of timeMap.cuts) {
    const cutStart = frameAtMs(cut.startMs, rate);
    keep(cursor, cutStart);
    cursor = Math.max(cursor, frameAtMs(cut.endMs, rate));
  }
  keep(cursor, sourceFrames);
  const frames = offset;

  /** A source frame on the timeline: inside a kept stretch, or the nearest edge of one. */
  const place = (
    sourceFrame: number,
    edge: "start" | "end",
  ): { readonly frame: number; readonly item: number } | null => {
    if (items.length === 0) return null;
    for (const [index, item] of items.entries()) {
      const itemEnd = item.sourceStart + item.duration;
      const inside =
        edge === "start"
          ? sourceFrame >= item.sourceStart && sourceFrame < itemEnd
          : sourceFrame > item.sourceStart && sourceFrame <= itemEnd;
      if (inside) return { frame: item.offset + sourceFrame - item.sourceStart, item: index };
      // In a cut (only by rounding: a mapped caption starts and ends on kept
      // time): a start moves on to the next stretch, an end back to the last.
      if (sourceFrame < item.sourceStart) {
        if (edge === "start") return { frame: item.offset, item: index };
        const previous = items[index - 1];
        return previous === undefined
          ? null
          : { frame: previous.offset + previous.duration, item: index - 1 };
      }
    }
    const last = items[items.length - 1];
    return last === undefined || edge === "start"
      ? null
      : { frame: last.offset + last.duration, item: items.length - 1 };
  };

  const placed: TimelineCaption[] = [];
  const chunks = [...input.chunks].sort((a, b) => a.chunkIdx - b.chunkIdx);
  const words = chunks.flatMap((chunk) => chunk.words);
  const wordIndex = new Map(words.map((word, index) => [word.wid, index]));
  for (const segment of input.segments) {
    if (segment.hidden === true) continue;
    // The caption's words and text exactly as a subtitle export writes them.
    const [cue] = toCues({
      transcriptId: "",
      revision: 0,
      language: "",
      chunks,
      segments: [segment],
    }) as [Cue?];
    if (cue === undefined) continue;
    const from = wordIndex.get(segment.startWordId);
    const to = wordIndex.get(segment.endWordId);
    const own = from === undefined || to === undefined ? [] : words.slice(from, to + 1);
    const mapped = timeMap.mapSegment(segment, own);
    const first = mapped.visibleRanges[0];
    const last = mapped.visibleRanges[mapped.visibleRanges.length - 1];
    if (mapped.hidden || first === undefined || last === undefined) continue;
    const start = place(frameAtMs(first.sourceStart, rate), "start");
    const end = place(frameAtMs(last.sourceEnd, rate), "end");
    if (start === null) continue;
    const endFrame = Math.min(frames, Math.max(end?.frame ?? start.frame + 1, start.frame + 1));
    if (endFrame <= start.frame) continue;
    placed.push({ start: start.frame, end: endFrame, text: cue.text, item: start.item });
  }

  // In time order, and never two at once.
  placed.sort((a, b) => a.start - b.start);
  const captions: TimelineCaption[] = [];
  for (const [index, caption] of placed.entries()) {
    const next = placed[index + 1];
    const end = next === undefined ? caption.end : Math.min(caption.end, next.start);
    if (end > caption.start) captions.push({ ...caption, end });
  }

  return {
    rate,
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
    hasAudio: input.hasAudio,
    sourceFrames,
    frames,
    items,
    captions,
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Text as XML 1.0 character data or an attribute value: the five markup
 * characters escaped, and the characters XML 1.0 cannot hold at all (control
 * characters other than tab and line breaks, lone surrogates, U+FFFE/U+FFFF)
 * removed rather than written as an error an editor refuses the whole file for.
 */
export function xmlText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/**
 * The clean cut as an absolute `file:` URL at the root of the disk, its name
 * percent-encoded: `file:///My%20clip%209x16.mp4` for FCPXML,
 * `file://localhost/My%20clip%209x16.mp4` (Final Cut Pro 7's own form) for
 * xmeml. Deliberately a path that does not exist: every editor then imports
 * the timeline with the clip offline and relinks it, where a relative URL can
 * fail the import outright (see the module comment).
 */
export function mediaFileUrl(filename: string, form: "fcpxml" | "xmeml"): string {
  const path = encodeURIComponent(filename);
  return form === "xmeml" ? `file://localhost/${path}` : `file:///${path}`;
}

/** The captions as SubRip on the timeline's clock (the subtitle export's writer). */
export function timelineSrt(timeline: NleTimeline): string {
  return toSrt(
    timeline.captions.map((caption) => ({
      startMs: msAtFrame(caption.start, timeline.rate),
      endMs: msAtFrame(caption.end, timeline.rate),
      text: caption.text,
    })),
  );
}

export interface NleNames {
  /** The timeline's name (the clip's title and shape). */
  readonly project: string;
  /** The folder it is filed under in the editor (the video's title). */
  readonly event: string;
  /** The clean cut's file name in the ZIP, next to the timeline. */
  readonly mediaFile: string;
}

/** The Basic Title every Final Cut Pro install has (and Resolve maps to Text+). */
const BASIC_TITLE_UID =
  ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti";

/** Caption size: about a twentieth of the frame's height, as the captions are drawn. */
function titleFontSize(timeline: NleTimeline): number {
  return Math.max(24, Math.round(Math.min(timeline.width, timeline.height) / 14));
}

/**
 * FCPXML 1.9: the kept stretches on the primary storyline, every caption a
 * Basic Title connected above the stretch it starts in.
 */
export function toFcpxml(timeline: NleTimeline, names: NleNames): string {
  const { rate } = timeline;
  const t = (frames: number): string => fcpTime(frames, rate);
  const fontSize = titleFontSize(timeline);
  const audio = timeline.hasAudio
    ? ' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"'
    : "";
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE fcpxml>",
    '<fcpxml version="1.9">',
    "  <resources>",
    `    <format id="r1" frameDuration="${t(1)}" width="${String(timeline.width)}" height="${String(timeline.height)}" colorSpace="1-1-1 (Rec. 709)"/>`,
    `    <asset id="r2" name="${xmlText(names.mediaFile)}" start="0s" duration="${t(timeline.sourceFrames)}" hasVideo="1" format="r1"${audio}>`,
    `      <media-rep kind="original-media" src="${xmlText(mediaFileUrl(names.mediaFile, "fcpxml"))}"/>`,
    "    </asset>",
    `    <effect id="r3" name="Basic Title" uid="${BASIC_TITLE_UID}"/>`,
    "  </resources>",
    "  <library>",
    `    <event name="${xmlText(names.event)}">`,
    `      <project name="${xmlText(names.project)}">`,
    `        <sequence format="r1" duration="${t(timeline.frames)}" tcStart="0s" tcFormat="NDF"${timeline.hasAudio ? ' audioLayout="stereo" audioRate="48k"' : ""}>`,
    "          <spine>",
  ];
  let style = 0;
  for (const [index, item] of timeline.items.entries()) {
    lines.push(
      `            <asset-clip ref="r2" name="${xmlText(names.mediaFile)}" offset="${t(item.offset)}" start="${t(item.sourceStart)}" duration="${t(item.duration)}" format="r1" tcFormat="NDF">`,
    );
    for (const caption of timeline.captions) {
      if (caption.item !== index) continue;
      style += 1;
      const id = `ts${String(style)}`;
      // A connected clip's offset is on its parent's own clock, which starts
      // at the parent's `start` (the clean cut's frame it plays first).
      const at = item.sourceStart + caption.start - item.offset;
      lines.push(
        `              <title ref="r3" lane="1" name="${xmlText(caption.text.slice(0, 60))}" offset="${t(at)}" start="3600s" duration="${t(caption.end - caption.start)}">`,
        "                <text>",
        `                  <text-style ref="${id}">${xmlText(caption.text)}</text-style>`,
        "                </text>",
        `                <text-style-def id="${id}">`,
        `                  <text-style font="Helvetica" fontSize="${String(fontSize)}" fontFace="Bold" fontColor="1 1 1 1" bold="1" alignment="center"/>`,
        "                </text-style-def>",
        "              </title>",
      );
    }
    lines.push("            </asset-clip>");
  }
  lines.push(
    "          </spine>",
    "        </sequence>",
    "      </project>",
    "    </event>",
    "  </library>",
    "</fcpxml>",
    "",
  );
  return lines.join("\n");
}

/**
 * Final Cut Pro 7 XML (xmeml 4), as Premiere Pro imports it: the kept
 * stretches on V1 and their sound on A1, the file described once and named
 * by id after that.
 */
export function toXmeml(timeline: NleTimeline, names: NleNames): string {
  const { rate } = timeline;
  const rateXml = (indent: string): string[] => [
    `${indent}<rate>`,
    `${indent}  <timebase>${String(timebaseOf(rate))}</timebase>`,
    `${indent}  <ntsc>${isNtsc(rate) ? "TRUE" : "FALSE"}</ntsc>`,
    `${indent}</rate>`,
  ];
  const videoCharacteristics = (indent: string): string[] => [
    `${indent}<samplecharacteristics>`,
    ...rateXml(`${indent}  `),
    `${indent}  <width>${String(timeline.width)}</width>`,
    `${indent}  <height>${String(timeline.height)}</height>`,
    `${indent}  <anamorphic>FALSE</anamorphic>`,
    `${indent}  <pixelaspectratio>square</pixelaspectratio>`,
    `${indent}  <fielddominance>none</fielddominance>`,
    `${indent}</samplecharacteristics>`,
  ];
  let fileDescribed = false;
  const file = (indent: string): string[] => {
    if (fileDescribed) return [`${indent}<file id="file-1"/>`];
    fileDescribed = true;
    return [
      `${indent}<file id="file-1">`,
      `${indent}  <name>${xmlText(names.mediaFile)}</name>`,
      `${indent}  <pathurl>${xmlText(mediaFileUrl(names.mediaFile, "xmeml"))}</pathurl>`,
      ...rateXml(`${indent}  `),
      `${indent}  <duration>${String(timeline.sourceFrames)}</duration>`,
      `${indent}  <media>`,
      `${indent}    <video>`,
      ...videoCharacteristics(`${indent}      `),
      `${indent}    </video>`,
      ...(timeline.hasAudio
        ? [
            `${indent}    <audio>`,
            `${indent}      <samplecharacteristics>`,
            `${indent}        <depth>16</depth>`,
            `${indent}        <samplerate>48000</samplerate>`,
            `${indent}      </samplecharacteristics>`,
            `${indent}      <channelcount>2</channelcount>`,
            `${indent}    </audio>`,
          ]
        : []),
      `${indent}  </media>`,
      `${indent}</file>`,
    ];
  };
  const clipItem = (
    kind: "video" | "audio",
    item: TimelineItem,
    index: number,
    indent: string,
  ): string[] => [
    `${indent}<clipitem id="clipitem-${kind === "video" ? "v" : "a"}${String(index + 1)}">`,
    `${indent}  <name>${xmlText(names.mediaFile)}</name>`,
    `${indent}  <enabled>TRUE</enabled>`,
    `${indent}  <duration>${String(timeline.sourceFrames)}</duration>`,
    ...rateXml(`${indent}  `),
    `${indent}  <start>${String(item.offset)}</start>`,
    `${indent}  <end>${String(item.offset + item.duration)}</end>`,
    `${indent}  <in>${String(item.sourceStart)}</in>`,
    `${indent}  <out>${String(item.sourceStart + item.duration)}</out>`,
    ...file(`${indent}  `),
    ...(kind === "audio"
      ? [
          `${indent}  <sourcetrack>`,
          `${indent}    <mediatype>audio</mediatype>`,
          `${indent}    <trackindex>1</trackindex>`,
          `${indent}  </sourcetrack>`,
        ]
      : []),
    `${indent}</clipitem>`,
  ];

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${xmlText(names.project)}</name>`,
    `    <duration>${String(timeline.frames)}</duration>`,
    ...rateXml("    "),
    "    <timecode>",
    ...rateXml("      "),
    "      <string>00:00:00:00</string>",
    "      <frame>0</frame>",
    "      <displayformat>NDF</displayformat>",
    "    </timecode>",
    "    <media>",
    "      <video>",
    "        <format>",
    ...videoCharacteristics("          "),
    "        </format>",
    "        <track>",
  ];
  for (const [index, item] of timeline.items.entries()) {
    lines.push(...clipItem("video", item, index, "          "));
  }
  lines.push("        </track>", "      </video>");
  if (timeline.hasAudio) {
    lines.push("      <audio>", "        <track>");
    for (const [index, item] of timeline.items.entries()) {
      lines.push(...clipItem("audio", item, index, "          "));
    }
    lines.push("        </track>", "      </audio>");
  }
  lines.push("    </media>", "  </sequence>", "</xmeml>", "");
  return lines.join("\n");
}

/**
 * "Read me.txt": what each file is for, how each app opens it (in that app's
 * own menu names), and how to point each app at the video, which every app
 * asks for once because a timeline cannot know the folder it was unzipped to.
 */
export function readMeText(
  names: NleNames,
  files: { readonly fcpxml: string; readonly xmeml: string; readonly srt: string },
): string {
  const video = names.mediaFile;
  return [
    names.project,
    "",
    "Unzip this folder first, and keep every file in it together.",
    "",
    video,
    "  The clip without captions: the video every timeline below uses.",
    "",
    files.fcpxml,
    "  For Final Cut Pro and DaVinci Resolve. The clip is on the timeline as",
    "  Aksharo cut it, with every caption as a title above it.",
    "",
    files.xmeml,
    "  For Premiere Pro. The clip is on V1 (its sound on A1) as Aksharo cut it.",
    "",
    files.srt,
    "  The captions as subtitles, timed to the timelines above (not to the uncut",
    "  video when Aksharo trimmed pauses out of it).",
    "",
    "Each app opens the timeline with the video shown as missing (offline) until",
    "you point it at the video in this folder. That is expected: a timeline file",
    "cannot know where you unzipped it.",
    "",
    "Final Cut Pro",
    `  1. File > Import > XML..., then choose ${files.fcpxml}.`,
    "  2. In the new event, select the clip marked missing.",
    "  3. File > Relink Files..., choose Missing, then Locate All...",
    `  4. Choose ${video} in this folder, then Relink Files.`,
    "",
    "DaVinci Resolve",
    `  1. File > Import > Timeline..., then choose ${files.fcpxml}.`,
    '  2. Leave "Automatically import source clips into media pool" ticked, then Ok.',
    "  3. If Resolve says it cannot find the clip, choose this folder when it asks.",
    "     If the clip still shows as offline: in the Media Pool, right-click it,",
    "     choose Relink Selected Clips..., and choose this folder.",
    "",
    "Premiere Pro",
    `  1. File > Import..., then choose ${files.xmeml}.`,
    `  2. In the Link Media window, click Locate, choose ${video}`,
    "     in this folder, then OK.",
    `  3. For the captions: File > Import..., choose ${files.srt}, then drag it`,
    "     from the Project panel onto the timeline. It becomes a caption track.",
    "",
  ].join("\r\n");
}
