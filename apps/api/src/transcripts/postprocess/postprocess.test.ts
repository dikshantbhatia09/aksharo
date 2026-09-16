import { describe, expect, it } from "vitest";

import type { TranscriptChunk, Word } from "@montaj/edg/schemas";

import { tagFillers, lexiconFor, lexiconKeysFor, lexiconLanguages } from "./fillers.js";
import { applyGlossary, buildGlossaryIndex, EMPTY_GLOSSARY_SOURCE } from "./glossary.js";
import { identifyLanguage, scriptSlots } from "./lid.js";
import {
  defaultNumeralParams,
  foldNumberRun,
  groupIndian,
  groupWestern,
  normaliseNumerals,
} from "./numerals.js";
import { editDistance, phoneticKey } from "./phonetic.js";
import { normaliseTimings, postProcess } from "./pipeline.js";
import {
  defaultPunctuationParams,
  endsSentence,
  punctuate,
  restorePunctuation,
} from "./punctuation.js";
import { normaliseSpeakers } from "./speakers.js";

import type { GlossaryTerm } from "./glossary.js";

/**
 * Table-driven post-processing tests across the three scripts of `09 §3`:
 * Roman Hinglish, Devanagari Hindi and Tamil.
 *
 * The tables are the unit of review. Every row is one utterance the pipeline is
 * expected to change (or deliberately leave alone), written the way a reviewer
 * would say it out loud — which is the only way a linguist can check the Hindi
 * rows without reading TypeScript.
 */

/** Build words with sensible defaults; `gap` is silence BEFORE the word. */
function words(specs: readonly (Partial<Word> & { gap?: number })[]): Word[] {
  let cursor = 0;
  return specs.map((spec, index) => {
    cursor += spec.gap ?? 40;
    const s = spec.s ?? cursor;
    const e = spec.e ?? s + 400;
    cursor = e;
    return {
      wid: (spec.wid ?? `0:${index}`) as Word["wid"],
      s,
      e,
      t: spec.t ?? "word",
      ...(spec.sp === undefined ? {} : { sp: spec.sp }),
      ...(spec.c === undefined ? {} : { c: spec.c }),
      ...(spec.scripts === undefined ? {} : { scripts: spec.scripts }),
      ...(spec.filler === undefined ? {} : { filler: spec.filler }),
      ...(spec.deleted === undefined ? {} : { deleted: spec.deleted }),
    };
  });
}

/** One sentence's worth of words from a space-separated string. */
function sentence(text: string, options: { gap?: number; sp?: string } = {}): Word[] {
  return words(
    text.split(" ").map((token) => ({
      t: token,
      gap: options.gap ?? 40,
      ...(options.sp === undefined ? {} : { sp: options.sp }),
    })),
  );
}

const texts = (list: readonly Word[]): string[] =>
  list.filter((word) => word.deleted !== true).map((word) => word.t);

// ---------------------------------------------------------------------------
// Punctuation
// ---------------------------------------------------------------------------

describe("punctuation restoration", () => {
  const cases: readonly {
    name: string;
    language: string;
    input: Word[];
    expected: string[];
  }[] = [
    {
      name: "latin: a 600 ms pause ends the sentence and the next word is capitalised",
      language: "hi-Latn",
      input: words([
        { t: "chalo", s: 0, e: 400 },
        { t: "shuru", s: 440, e: 840 },
        { t: "karte", s: 880, e: 1280 },
        { t: "hain", s: 1320, e: 1800 },
        { t: "aur", s: 2600, e: 3000 },
        { t: "phir", s: 3040, e: 3440 },
      ]),
      expected: ["Chalo", "shuru", "karte", "hain.", "Aur", "phir"],
    },
    {
      name: "latin: the provider's own full stop is never doubled",
      language: "en",
      input: words([
        { t: "Right.", s: 0, e: 400 },
        { t: "next", s: 1200, e: 1600 },
      ]),
      expected: ["Right.", "Next"],
    },
    {
      name: "latin: a comma is a boundary the rules leave alone",
      language: "en",
      input: words([
        { t: "well,", s: 0, e: 400 },
        { t: "anyway", s: 1200, e: 1600 },
      ]),
      expected: ["Well,", "anyway"],
    },
    {
      name: "devanagari: a danda, not a full stop, and no capitals",
      language: "hi",
      input: words([
        { t: "दोस्तों", s: 0, e: 400 },
        { t: "आज", s: 440, e: 840 },
        { t: "हम", s: 880, e: 1280 },
        { t: "बात", s: 1320, e: 1800 },
        { t: "करेंगे", s: 2600, e: 3000 },
      ]),
      expected: ["दोस्तों", "आज", "हम", "बात।", "करेंगे"],
    },
    {
      name: "devanagari: an existing danda is respected",
      language: "hi",
      input: words([
        { t: "ठीक।", s: 0, e: 400 },
        { t: "अब", s: 1200, e: 1600 },
      ]),
      expected: ["ठीक।", "अब"],
    },
    {
      name: "tamil: a full stop, and no capitals to restore",
      language: "ta",
      input: words([
        { t: "நண்பர்களே", s: 0, e: 400 },
        { t: "இன்று", s: 440, e: 840 },
        { t: "நாம்", s: 1600, e: 2000 },
      ]),
      expected: ["நண்பர்களே", "இன்று.", "நாம்"],
    },
    {
      name: "the last word of a chunk is never terminated",
      language: "en",
      input: words([
        { t: "hello", s: 0, e: 400 },
        { t: "there", s: 440, e: 840 },
      ]),
      expected: ["Hello", "there"],
    },
    {
      name: "a pause below the threshold is not a sentence",
      language: "en",
      input: words([
        { t: "one", s: 0, e: 400 },
        { t: "two", s: 900, e: 1300 },
      ]),
      expected: ["One", "two"],
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const result = restorePunctuation(entry.input, defaultPunctuationParams(entry.language));
      expect(texts(result.words)).toEqual(entry.expected);
    });
  }

  it("logs every change with the word it changed", () => {
    const result = restorePunctuation(
      words([
        { t: "haan", s: 0, e: 400 },
        { t: "bilkul", s: 1200, e: 1600 },
        { t: "sahi", s: 1640, e: 2040 },
      ]),
      defaultPunctuationParams("hi-Latn"),
    );
    expect(result.corrections).toEqual([
      {
        step: "punctuation",
        wordId: "0:0",
        before: "haan",
        after: "Haan.",
        reason: expect.any(String),
      },
      {
        step: "punctuation",
        wordId: "0:1",
        before: "bilkul",
        after: "Bilkul",
        reason: "sentence start",
      },
    ]);
  });

  it("recognises sentence ends in every script", () => {
    expect(endsSentence("done.")).toBe(true);
    expect(endsSentence("किया।")).toBe(true);
    expect(endsSentence('"quoted."')).toBe(true);
    expect(endsSentence("really?")).toBe(true);
    expect(endsSentence("mid")).toBe(false);
  });
});

describe("the punctuation model seam", () => {
  const params = defaultPunctuationParams("en");

  it("uses a model's output and still runs the rules over it", async () => {
    const result = await punctuate(
      words([
        { t: "hello", s: 0, e: 400 },
        { t: "there", s: 440, e: 840 },
      ]),
      "en",
      params,
      { name: "test-model", punctuate: () => ["Hello,", "there"] },
    );
    expect(texts(result.words)).toEqual(["Hello,", "there"]);
    expect(result.corrections[0]?.reason).toBe("model test-model");
  });

  it("falls back to the rules when the model declines, throws or miscounts", async () => {
    const input = words([
      { t: "hello", s: 0, e: 400 },
      { t: "there", s: 440, e: 840 },
    ]);
    const decline = await punctuate(input, "en", params, {
      name: "quiet",
      punctuate: () => undefined,
    });
    const thrown = await punctuate(input, "en", params, {
      name: "broken",
      punctuate: () => {
        throw new Error("down");
      },
    });
    const miscount = await punctuate(input, "en", params, {
      name: "miscount",
      punctuate: () => ["only one"],
    });

    for (const result of [decline, thrown, miscount]) {
      expect(texts(result.words)).toEqual(["Hello", "there"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Numerals
// ---------------------------------------------------------------------------

describe("numeral normalisation", () => {
  const params = defaultNumeralParams();

  const cases: readonly { name: string; spoken: string; expected: string[] }[] = [
    {
      name: "roman hindi: ek lakh bees hazaar",
      spoken: "ek lakh bees hazaar",
      expected: ["1,20,000"],
    },
    { name: "roman hindi: do lakh", spoken: "do lakh", expected: ["2,00,000"] },
    { name: "roman hindi: paanch sau", spoken: "paanch sau", expected: ["500"] },
    { name: "roman hindi: do hazaar bees", spoken: "do hazaar bees", expected: ["2,020"] },
    { name: "english: twenty five", spoken: "twenty five", expected: ["25"] },
    { name: "english: one crore", spoken: "one crore", expected: ["1,00,00,000"] },
    { name: "devanagari: एक लाख", spoken: "एक लाख", expected: ["1,00,000"] },
    { name: "devanagari: दो हज़ार बीस", spoken: "दो हज़ार बीस", expected: ["2,020"] },
    {
      name: "a lone number word is left exactly as the speaker said it",
      spoken: "ek",
      expected: ["ek"],
    },
    {
      name: "an ascending run is not a number and survives untouched",
      spoken: "ek do teen",
      expected: ["ek", "do", "teen"],
    },
    {
      name: "a bare scale word is not an amount",
      spoken: "lakh",
      expected: ["lakh"],
    },
    {
      name: "digits already written are left alone",
      spoken: "2024",
      expected: ["2024"],
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const result = normaliseNumerals(sentence(entry.spoken), params);
      expect(texts(result.words)).toEqual(entry.expected);
    });
  }

  it("writes a currency amount with the symbol in front", () => {
    const result = normaliseNumerals(sentence("rupees ek lakh bees hazaar"), params);
    expect(texts(result.words)).toEqual(["rupees", "₹1,20,000"]);
    expect(result.corrections[0]).toMatchObject({
      step: "numerals",
      before: "ek lakh bees hazaar",
      after: "₹1,20,000",
      reason: "currency amount",
    });
  });

  it("writes a currency amount even for a single spoken number", () => {
    expect(texts(normaliseNumerals(sentence("rupaye pachaas"), params).words)).toEqual([
      "rupaye",
      "₹50",
    ]);
  });

  it("keeps the sentence's own punctuation on the folded number", () => {
    const result = normaliseNumerals(sentence("ek lakh bees hazaar."), params);
    expect(texts(result.words)).toEqual(["1,20,000."]);
  });

  it("tombstones the words a run consumed rather than dropping their ids", () => {
    const result = normaliseNumerals(sentence("ek lakh"), params);
    expect(result.words.map((word) => [word.wid, word.deleted ?? false])).toEqual([
      ["0:0", false],
      ["0:1", true],
    ]);
  });

  it("gives the folded number the whole run's time span", () => {
    const result = normaliseNumerals(sentence("ek lakh"), params);
    expect(result.words[0]?.e).toBe(sentence("ek lakh")[1]?.e);
  });

  it("groups the Indian way, and the Western way elsewhere", () => {
    expect(groupIndian(120_000)).toBe("1,20,000");
    expect(groupIndian(10_000_000)).toBe("1,00,00,000");
    expect(groupIndian(999)).toBe("999");
    expect(groupIndian(-120_000)).toBe("-1,20,000");
    expect(groupWestern(120_000)).toBe("120,000");
    expect(groupWestern(1_234_567)).toBe("1,234,567");
  });

  it("refuses to fold a run that does not read as a number", () => {
    expect(
      foldNumberRun([
        { value: 1, scale: false },
        { value: 2, scale: false },
      ]),
    ).toBeUndefined();
    expect(
      foldNumberRun([
        { value: 20, scale: false },
        { value: 5, scale: false },
      ]),
    ).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Glossary and remembered spellings
// ---------------------------------------------------------------------------

describe("glossary post-correction", () => {
  const terms: GlossaryTerm[] = [
    { term: "Aksharo", aliases: ["Akshero"], source: "glossary" },
    { term: "Sarvam", source: "glossary" },
    { term: "Bharat", source: "spelling" },
    { term: "प्रियंका", source: "spelling" },
    { term: "தமிழ்", source: "glossary" },
  ];
  const index = buildGlossaryIndex(terms);

  const cases: readonly { name: string; heard: string; expected: string; step?: string }[] = [
    { name: "latin: a one-letter slip", heard: "Akshara", expected: "Aksharo", step: "glossary" },
    { name: "latin: an aspiration slip", heard: "Bharath", expected: "Bharat", step: "spelling" },
    { name: "latin: a v/w swap", heard: "Sarwam", expected: "Sarvam", step: "glossary" },
    {
      name: "latin: the alias resolves to the canonical term",
      heard: "Akshero",
      expected: "Aksharo",
    },
    { name: "latin: an unrelated word is untouched", heard: "editing", expected: "editing" },
    {
      name: "devanagari: a matra slip",
      heard: "प्रियांका",
      expected: "प्रियंका",
      step: "spelling",
    },
    { name: "tamil: an exact match is left alone", heard: "தமிழ்", expected: "தமிழ்" },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const result = applyGlossary(sentence(entry.heard), index);
      expect(result.words[0]?.t).toBe(entry.expected);
      if (entry.step !== undefined) {
        expect(result.corrections[0]?.step).toBe(entry.step);
      }
    });
  }

  it("keeps trailing punctuation on a corrected word", () => {
    expect(applyGlossary(sentence("Akshara."), index).words[0]?.t).toBe("Aksharo.");
  });

  it("logs the term and the distance it matched at", () => {
    const result = applyGlossary(sentence("Akshara"), index);
    expect(result.corrections[0]).toMatchObject({
      step: "glossary",
      wordId: "0:0",
      before: "Akshara",
      after: "Aksharo",
    });
    expect(result.corrections[0]?.reason).toContain("Aksharo");
  });

  it("changes nothing when the workspace has no terms", async () => {
    const empty = buildGlossaryIndex(await EMPTY_GLOSSARY_SOURCE.terms("ws"));
    const input = sentence("Akshara");
    const result = applyGlossary(input, empty);
    expect(result.words).toBe(input);
    expect(result.corrections).toEqual([]);
  });

  it("rewrites the matching script slot as well as the primary text", () => {
    const input = words([{ t: "Akshara", scripts: { roman: "Akshara", native: "अक्षरो" } }]);
    const result = applyGlossary(input, index);
    expect(result.words[0]?.scripts).toEqual({ roman: "Aksharo", native: "अक्षरो" });
  });

  it("does not rewrite a word that is merely spelled similarly but sounds different", () => {
    expect(applyGlossary(sentence("sharp"), index).words[0]?.t).toBe("sharp");
  });
});

describe("phonetic keys and edit distance", () => {
  it("gives the same key to spellings a Hindi speaker swaps freely", () => {
    expect(phoneticKey("Sarvam")).toBe(phoneticKey("Sarwam"));
    expect(phoneticKey("Bharat")).toBe(phoneticKey("Bharath"));
    expect(phoneticKey("phone")).toBe(phoneticKey("fone"));
    expect(phoneticKey("jindagi")).toBe(phoneticKey("zindagi"));
  });

  it("reduces an Indic word to its consonant skeleton", () => {
    expect(phoneticKey("प्रियंका")).toBe(phoneticKey("प्रियांका"));
    expect(phoneticKey("करेंगे")).toBe(phoneticKey("करेगे"));
  });

  it("has no key for a token with no letters", () => {
    expect(phoneticKey("—")).toBe("");
    expect(phoneticKey("")).toBe("");
  });

  it("caps the distance it will compute", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("kitten", "sitting", 2)).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
    expect(editDistance("a", "abcdefgh", 2)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fillers
// ---------------------------------------------------------------------------

describe("filler tagging", () => {
  const flagged = (list: readonly Word[]): string[] =>
    list.filter((word) => word.filler === true).map((word) => word.t);

  const cases: readonly { name: string; language: string; input: Word[]; expected: string[] }[] = [
    {
      name: "english: um and basically are always fillers",
      language: "en",
      input: sentence("um basically we start here"),
      expected: ["um", "basically"],
    },
    {
      name: "english: the phrase 'you know' is tagged as a whole",
      language: "en",
      input: sentence("we can you know start now"),
      expected: ["you", "know"],
    },
    {
      name: "roman hindi: matlab and yaani are always fillers",
      language: "hi-Latn",
      input: sentence("matlab yaani samajh gaye"),
      expected: ["matlab", "yaani"],
    },
    {
      name: "roman hindi: 'kya bolte hain' is tagged as a phrase",
      language: "hi-Latn",
      input: sentence("woh kya bolte hain wala scene"),
      expected: ["woh", "kya", "bolte", "hain"],
    },
    {
      name: "devanagari: मतलब is a filler",
      language: "hi",
      input: sentence("मतलब हम शुरू करते हैं"),
      expected: ["मतलब"],
    },
    {
      name: "tamil: அப்புறம் is a filler",
      language: "ta",
      input: sentence("அப்புறம் நாம் தொடங்குவோம்"),
      expected: ["அப்புறம்"],
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      expect(flagged(tagFillers(entry.input, entry.language).words)).toEqual(entry.expected);
    });
  }

  it("tags a contextual filler only when a pause brackets it", () => {
    // "toh main gaya" — no pause, an ordinary sentence.
    const fluent = words([
      { t: "abhi", s: 0, e: 400 },
      { t: "toh", s: 440, e: 700 },
      { t: "main", s: 740, e: 1140 },
      { t: "gaya", s: 1180, e: 1580 },
    ]);
    expect(tagFillers(fluent, "hi-Latn").words.some((word) => word.filler === true)).toBe(false);

    // "abhi… toh… main gaya" — the same word, held.
    const stalled = words([
      { t: "abhi", s: 0, e: 400 },
      { t: "toh", s: 900, e: 1200 },
      { t: "main", s: 1240, e: 1640 },
      { t: "gaya", s: 1680, e: 2080 },
    ]);
    expect(
      tagFillers(stalled, "hi-Latn").words.filter((word) => word.filler === true),
    ).toHaveLength(1);
  });

  it("never clears a flag the worker already set", () => {
    const input = words([{ t: "hmmmmm", filler: true }]);
    const result = tagFillers(input, "en");
    expect(result.words[0]?.filler).toBe(true);
    // Already flagged, so nothing to log.
    expect(result.corrections).toEqual([]);
  });

  it("logs which lexicon entry fired", () => {
    const result = tagFillers(sentence("matlab shuru"), "hi-Latn");
    expect(result.corrections[0]).toMatchObject({ step: "fillers", wordId: "0:0" });
    expect(result.corrections[0]?.reason).toContain("matlab");
  });

  it("reads English alongside the transcript's own language", () => {
    expect(lexiconKeysFor("hi-Latn")).toContain("en");
    expect(lexiconKeysFor("hi-Latn")).toContain("hi");
    expect(lexiconKeysFor("hi-Deva")).toContain("hi-Deva");
    expect(lexiconFor("ta").single.size).toBeGreaterThan(0);
    expect(lexiconLanguages()).toContain("ta");
  });
});

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

describe("speaker normalisation", () => {
  it("renumbers by first appearance across the whole transcript", () => {
    const input = words([
      { t: "one", sp: "SPEAKER_07" },
      { t: "two", sp: "SPEAKER_02" },
      { t: "three", sp: "SPEAKER_07" },
    ]);
    const result = normaliseSpeakers(input);
    expect(result.words.map((word) => word.sp)).toEqual(["s1", "s2", "s1"]);
    expect(result.speakers).toEqual([{ id: "s1" }, { id: "s2" }]);
    expect(result.mapping.get("SPEAKER_07")).toBe("s1");
  });

  it("leaves an undiarised transcript without speakers", () => {
    const input = sentence("no speakers here");
    const result = normaliseSpeakers(input);
    expect(result.speakers).toEqual([]);
    expect(result.words).toEqual(input);
  });

  it("does not log a change when the labels are already normalised", () => {
    const result = normaliseSpeakers(
      words([
        { t: "a", sp: "s1" },
        { t: "b", sp: "s2" },
      ]),
    );
    expect(result.corrections).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two-signal LID (D14)
// ---------------------------------------------------------------------------

describe("two-signal language identification", () => {
  const cases: readonly {
    name: string;
    provider: string;
    text: string;
    expected: string;
    disagreed: boolean;
  }[] = [
    {
      name: "provider says hi, the words are Roman: Hinglish",
      provider: "hi",
      text: "aaj hum video editing karenge",
      expected: "hi-Latn",
      disagreed: true,
    },
    {
      name: "provider says hi, the words are Devanagari: plain hi",
      provider: "hi",
      text: "आज हम बात करेंगे",
      expected: "hi",
      disagreed: false,
    },
    {
      name: "provider says en, the words are Latin: plain en",
      provider: "en",
      text: "today we are going to talk",
      expected: "en",
      disagreed: false,
    },
    {
      name: "provider says ta, the words are Tamil: plain ta",
      provider: "ta",
      text: "இன்று நாம் பேசுவோம்",
      expected: "ta",
      disagreed: false,
    },
    {
      name: "provider says ta, the words are Roman: ta-Latn",
      provider: "ta",
      text: "indru naam pesuvom",
      expected: "ta-Latn",
      disagreed: true,
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const verdict = identifyLanguage({
        words: sentence(entry.text),
        providerLanguage: entry.provider,
      });
      expect(verdict.language).toBe(entry.expected);
      expect(verdict.disagreed).toBe(entry.disagreed);
      expect(verdict.detected.map((signal) => signal.source)).toEqual(["provider", "script"]);
    });
  }

  it("records both signals with their confidences", () => {
    const verdict = identifyLanguage({
      words: sentence("aaj hum baat karenge"),
      providerLanguage: "hi",
      providerConfidence: 0.91,
    });
    expect(verdict.detected[0]).toEqual({ language: "hi", confidence: 0.91, source: "provider" });
    expect(verdict.detected[1]).toEqual({ language: "hi-Latn", confidence: 1, source: "script" });
  });

  it("lets a caller's hint win over both signals", () => {
    const verdict = identifyLanguage({
      words: sentence("aaj hum baat karenge"),
      providerLanguage: "en",
      hint: "hi-Latn",
    });
    expect(verdict.language).toBe("hi-Latn");
  });

  it("keeps a provider tag that already names a script", () => {
    expect(
      identifyLanguage({ words: sentence("aaj hum"), providerLanguage: "hi-Latn" }).language,
    ).toBe("hi-Latn");
  });

  it("reports the script slots the words carry", () => {
    expect(scriptSlots(words([{ t: "aaj", scripts: { roman: "aaj", native: "आज" } }]))).toEqual([
      "roman",
      "native",
    ]);
    expect(scriptSlots(sentence("plain latin"))).toEqual(["roman"]);
    expect(scriptSlots(sentence("आज हम"))).toEqual(["native"]);
  });
});

// ---------------------------------------------------------------------------
// The pipeline end to end
// ---------------------------------------------------------------------------

describe("the pipeline", () => {
  function chunk(list: Word[], chunkIdx = 0): TranscriptChunk {
    const first = list[0];
    const last = list[list.length - 1];
    return {
      chunkIdx,
      startMs: first?.s ?? 0,
      endMs: last?.e ?? 0,
      words: list,
    };
  }

  it("rounds ASR timings to integer milliseconds and clamps them into the chunk", () => {
    const rounded = normaliseTimings({
      chunkIdx: 0,
      startMs: 0.4,
      endMs: 2_000.6,
      words: [
        { wid: "0:0", s: 320.4, e: 768.6, t: "Bhai" },
        { wid: "0:1", s: 1_900.2, e: 2_400.9, t: "aaj" },
      ],
    });
    expect(rounded.startMs).toBe(0);
    expect(rounded.endMs).toBe(2_001);
    expect(rounded.words.map((word) => [word.s, word.e])).toEqual([
      [320, 769],
      [1_900, 2_001],
    ]);
    for (const word of rounded.words) {
      expect(Number.isInteger(word.s)).toBe(true);
      expect(Number.isInteger(word.e)).toBe(true);
    }
  });

  it("runs every step in order over a Hinglish transcript and logs what changed", async () => {
    const result = await postProcess(
      [
        chunk(
          words([
            { t: "matlab", s: 0, e: 400, sp: "SPEAKER_01" },
            { t: "Akshara", s: 440, e: 900, sp: "SPEAKER_01" },
            { t: "ke", s: 940, e: 1200, sp: "SPEAKER_01" },
            { t: "paas", s: 1240, e: 1700, sp: "SPEAKER_01" },
            { t: "ek", s: 2500, e: 2800, sp: "SPEAKER_02" },
            { t: "lakh", s: 2840, e: 3300, sp: "SPEAKER_02" },
            { t: "users", s: 3340, e: 3900, sp: "SPEAKER_02" },
          ]),
        ),
      ],
      {
        providerLanguage: "hi",
        workspaceId: "ws",
        extraTerms: [{ term: "Aksharo", source: "glossary" }],
      },
    );

    expect(result.language).toBe("hi-Latn");
    expect(result.languageDisagreement).toBe(true);
    expect(result.speakers).toEqual([{ id: "s1" }, { id: "s2" }]);
    expect(texts(result.chunks[0]?.words ?? [])).toEqual([
      // The transcript's first word is a sentence start, capitals included.
      "Matlab",
      "Aksharo",
      "ke",
      "paas.",
      "1,00,000",
      "users",
    ]);
    expect(result.steps).toEqual(
      expect.arrayContaining(["speakers", "punctuation", "numerals", "glossary", "fillers"]),
    );
    expect(result.corrections.every((correction) => correction.wordId !== "")).toBe(true);
  });

  it("never claims a native script when the ASR gave no Devanagari at all", async () => {
    // `local-whisper` transcribing spoken Hindi can hand back words already in
    // Latin script (exactly this table's "matlab"/"Akshara"/... above) with no
    // Devanagari signal anywhere. There is then no genuine native-script form
    // to show, and the pipeline must not fabricate one by copying the Latin
    // text into `scripts.native` -- that is what let the editor's Native tab
    // silently render the same Roman text no matter what a user clicked
    // (confirmed live on project `01M2AT48M2ERZ8J1AX2DS3H667`).
    const result = await postProcess(
      [chunk(words([{ t: "matlab" }, { t: "Akshara" }, { t: "ke" }, { t: "paas" }]))],
      { providerLanguage: "hi", workspaceId: "ws" },
    );

    expect(result.language).toBe("hi-Latn");
    // No word carries a real Devanagari form, so `native` is not on offer --
    // the script strip's own "click an unavailable tab" path is what should
    // produce one (via the real, bidirectional rule-table transliterator),
    // not this pipeline pretending it already has.
    expect(result.scripts).toEqual(["roman"]);
    for (const word of result.chunks[0]?.words ?? []) {
      expect(word.scripts?.native).toBeUndefined();
    }
  });

  it("keeps a genuine Devanagari native form when the ASR actually gave one", async () => {
    const result = await postProcess([chunk(words([{ t: "बारिश" }, { t: "हो" }]))], {
      providerLanguage: "hi",
      hint: "hi-Latn",
      workspaceId: "ws",
    });

    expect(result.scripts).toEqual(["roman", "native"]);
    const [first, second] = result.chunks[0]?.words ?? [];
    expect(first?.scripts?.native).toBe("बारिश");
    expect(first?.t).toBe("baarish");
    expect(second?.scripts?.native).toBe("हो");
  });

  it("keeps chunk boundaries and word ids intact across chunks", async () => {
    const first = words([
      { t: "pehla", s: 0, e: 400 },
      { t: "chunk", s: 440, e: 840 },
    ]);
    const second = [
      { wid: "1:0" as Word["wid"], s: 600_000, e: 600_400, t: "doosra" },
      { wid: "1:1" as Word["wid"], s: 600_440, e: 600_840, t: "chunk" },
    ];
    const result = await postProcess([chunk(first, 0), chunk(second, 1)], {
      providerLanguage: "hi-Latn",
      workspaceId: "ws",
    });

    expect(result.chunks.map((entry) => entry.chunkIdx)).toEqual([0, 1]);
    expect(result.chunks.flatMap((entry) => entry.words.map((word) => word.wid))).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
    ]);
  });

  it("asks the glossary source for the workspace's own terms", async () => {
    const asked: string[] = [];
    const result = await postProcess([chunk(sentence("Sarwam ka model"))], {
      providerLanguage: "hi-Latn",
      workspaceId: "01JCWS0000000000000000000A",
      glossarySource: {
        terms: async (workspaceId) => {
          asked.push(workspaceId);
          return [{ term: "Sarvam", source: "glossary" }];
        },
      },
    });
    expect(asked).toEqual(["01JCWS0000000000000000000A"]);
    expect(texts(result.chunks[0]?.words ?? [])[0]).toBe("Sarvam");
  });
});
