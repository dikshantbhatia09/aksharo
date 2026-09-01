import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Word } from "../src/schemas/transcript.js";
import { charCount, dominantScript, limitsFor } from "../src/segmenter/script.js";
import { DEFAULT_SEGMENTER_PARAMS, segmentWords, wrapLines } from "../src/segmenter/segmenter.js";

/**
 * Regenerates `fixtures/segmenter-golden.json`.
 *
 * The fixture is the segmenter's contract with the caption UI: three transcripts
 * — Roman Hinglish, Devanagari Hindi and Tamil — and exactly the segments the
 * segmenter must produce for them, written out with the wrapped lines, their
 * character counts and the reading speed so a human can review the line lengths
 * rather than trust a diff of word ids.
 *
 * Run it only when the segmentation rules deliberately change, and read the
 * printed table before committing the result:
 *
 *   pnpm --filter @montaj/edg golden:build
 */

interface Run {
  speaker: string;
  text: string;
}

interface CaseSpec {
  name: string;
  language: string;
  runs: Run[];
}

const CASES: readonly CaseSpec[] = [
  {
    name: "hinglish-roman",
    language: "hi-Latn",
    runs: [
      {
        speaker: "sp1",
        text: "Bhai aaj hum video editing ke bare mein baat karenge. Pehle timeline samjhenge, phir captions lagayenge aur thumbnail banayenge.",
      },
      { speaker: "sp2", text: "Haan bilkul, main ready hoon. Chalo shuru karte hain." },
    ],
  },
  {
    name: "hindi-devanagari",
    language: "hi",
    runs: [
      {
        speaker: "sp1",
        text: "दोस्तों आज हम वीडियो एडिटिंग के बारे में बात करेंगे। पहले टाइमलाइन समझेंगे, फिर कैप्शन लगाएंगे।",
      },
      { speaker: "sp2", text: "हाँ बिलकुल, मैं तैयार हूँ। चलो शुरू करते हैं।" },
    ],
  },
  {
    name: "tamil",
    language: "ta",
    runs: [
      {
        speaker: "sp1",
        text: "நண்பர்களே இன்று நாம் வீடியோ எடிட்டிங் பற்றி பேசுவோம். முதலில் டைம்லைனை புரிந்துகொள்வோம், பிறகு தலைப்புகளை சேர்ப்போம்.",
      },
      { speaker: "sp2", text: "ஆம் நிச்சயமாக, நான் தயார். வாருங்கள் தொடங்குவோம்." },
    ],
  },
];

const SENTENCE_END = /[.!?।]$/u;

/** Plausible ASR timings: a word lasts as long as it is, sentences get a pause. */
function buildWords(spec: CaseSpec): Word[] {
  const words: Word[] = [];
  let cursor = 240;
  let n = 0;
  for (const run of spec.runs) {
    for (const text of run.text.split(" ")) {
      const duration = Math.max(220, charCount(text) * 70);
      words.push({
        wid: `0:${n}` as Word["wid"],
        s: cursor,
        e: cursor + duration,
        t: text,
        sp: run.speaker,
      });
      n += 1;
      cursor += duration + (SENTENCE_END.test(text) ? 380 : 60);
    }
    cursor += 260;
  }
  return words;
}

/** Ids that read well in a committed fixture; the engine mints ULIDs at runtime. */
function goldenIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `SEG${String(counter).padStart(3, "0")}`;
  };
}

export function buildGolden() {
  return CASES.map((spec) => {
    const words = buildWords(spec);
    const segments = segmentWords(words, {}, { newId: goldenIds() });
    const script = dominantScript(words.map((word) => word.t));
    const limits = limitsFor(script);
    const bySpeaker = new Map(words.map((word) => [word.wid, word.sp]));
    const expected = segments.map((segment) => {
      const from = words.findIndex((word) => word.wid === segment.startWordId);
      const to = words.findIndex((word) => word.wid === segment.endWordId);
      const texts = words.slice(from, to + 1).map((word) => word.t);
      const lines = wrapLines(texts, limits.maxCharsPerLine);
      const durationMs = segment.endMs - segment.startMs;
      return {
        id: segment.id,
        seq: segment.seq,
        startWordId: segment.startWordId,
        endWordId: segment.endWordId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs,
        speaker: bySpeaker.get(segment.startWordId),
        lines,
        lineChars: lines.map((line) => charCount(line)),
        cps: Number(((charCount(texts.join(" ")) * 1000) / durationMs).toFixed(2)),
      };
    });
    return { name: spec.name, language: spec.language, script, limits, words, expected };
  });
}

/** The path of the committed fixture. */
export const GOLDEN_PATH = join(__dirname, "..", "fixtures", "segmenter-golden.json");

function main(): void {
  const cases = buildGolden();
  writeFileSync(
    GOLDEN_PATH,
    `${JSON.stringify({ params: DEFAULT_SEGMENTER_PARAMS, cases }, null, 2)}\n`,
    "utf8",
  );
  for (const entry of cases) {
    console.log(
      `\n=== ${entry.name} (${entry.script}: <= ${entry.limits.maxCharsPerLine} chars/line, <= ${entry.limits.maxCps} cps) ===`,
    );
    for (const segment of entry.expected) {
      console.log(
        `${String(segment.startMs).padStart(6)}-${String(segment.endMs).padStart(6)}` +
          ` ${String(segment.durationMs).padStart(5)}ms cps=${String(segment.cps).padStart(6)}` +
          ` ${segment.speaker ?? "?"} | ${segment.lines.join("  /  ")} [${segment.lineChars.join(",")}]`,
      );
    }
  }
}

if (require.main === module) main();
