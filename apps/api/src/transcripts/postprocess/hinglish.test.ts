import { describe, expect, it } from "vitest";
import type { TranscriptChunk, Word } from "@montaj/edg/schemas";
import { devanagariToHinglish } from "./transliterate.js";
import { repairHinglishWord } from "./repair.js";
import { postProcess } from "./pipeline.js";

describe("Hinglish Transliteration & Lexicon", () => {
  it("correctly transliterates conversational Hindi words without schwa corruption", () => {
    expect(devanagariToHinglish("अगर")).toBe("agar");
    expect(devanagariToHinglish("कमल")).toBe("kamal");
    expect(devanagariToHinglish("करना")).toBe("karna");
    expect(devanagariToHinglish("लड़का")).toBe("ladka");
    expect(devanagariToHinglish("समझना")).toBe("samajhna");
    expect(devanagariToHinglish("बारिश")).toBe("baarish");
    expect(devanagariToHinglish("भीग")).toBe("bheeg");
    expect(devanagariToHinglish("लेकिन")).toBe("lekin");
    expect(devanagariToHinglish("आपको")).toBe("aapko");
    expect(devanagariToHinglish("बढ़िया")).toBe("badhiya");
    expect(devanagariToHinglish("इधर")).toBe("idhar");
    expect(devanagariToHinglish("उधर")).toBe("udhar");
    expect(devanagariToHinglish("दिखाएंगे")).toBe("dikhayenge");
    expect(devanagariToHinglish("चाहिए")).toBe("chahiye");
    expect(devanagariToHinglish("मिलेगी")).toBe("milegi");
    expect(devanagariToHinglish("मिलेगा")).toBe("milega");
  });

  it("handles conversational fast-speech reductions and acoustic variants", () => {
    expect(devanagariToHinglish("लेके")).toBe("lekin");
    expect(devanagariToHinglish("दिखाईगे")).toBe("dikhayenge");
    expect(devanagariToHinglish("इदर")).toBe("idhar");
    expect(devanagariToHinglish("ची")).toBe("chahiye");
    expect(devanagariToHinglish("अपको")).toBe("aapko");
    expect(devanagariToHinglish("ड़ाई")).toBe("dhaai");
    expect(devanagariToHinglish("वादिो")).toBe("vaadiyon");
    expect(devanagariToHinglish("बादलो")).toBe("baadalon");
    expect(devanagariToHinglish("बरापडा")).toBe("bhara pada");
    expect(devanagariToHinglish("प्रप्रप्रटी")).toBe("property");
  });

  it("preserves English loanwords in real estate, architecture and creators", () => {
    expect(devanagariToHinglish("बेडरूम")).toBe("bedroom");
    expect(devanagariToHinglish("बाथरूम")).toBe("bathroom");
    expect(devanagariToHinglish("बंगलो")).toBe("bungalow");
    expect(devanagariToHinglish("प्राइवेट")).toBe("private");
    expect(devanagariToHinglish("पूल")).toBe("pool");
    expect(devanagariToHinglish("वेस्टर्न")).toBe("Western");
    expect(devanagariToHinglish("घाट्स")).toBe("Ghats");
    expect(devanagariToHinglish("व्यू")).toBe("view");
    expect(devanagariToHinglish("गार्डन")).toBe("garden");
    expect(devanagariToHinglish("एरिया")).toBe("area");
    expect(devanagariToHinglish("लग्जरी")).toBe("luxury");
    expect(devanagariToHinglish("प्रॉपर्टी")).toBe("property");
    expect(devanagariToHinglish("स्क्वायर")).toBe("square");
    expect(devanagariToHinglish("फीट")).toBe("feet");
    expect(devanagariToHinglish("करोड़")).toBe("crore");
  });

  it("normalises Roman colloquial spellings", () => {
    expect(devanagariToHinglish("idr")).toBe("idhar");
    expect(devanagariToHinglish("agr")).toBe("agar");
    expect(devanagariToHinglish("prprprtee")).toBe("property");
    expect(devanagariToHinglish("chee")).toBe("chahiye");
    expect(devanagariToHinglish("barapda")).toBe("bhara pada");
    expect(devanagariToHinglish("dikhaeege")).toBe("dikhayenge");
    expect(devanagariToHinglish("daee")).toBe("dhaai");
    expect(devanagariToHinglish("vadiyo")).toBe("vaadiyon");
    expect(devanagariToHinglish("badlo")).toBe("baadalon");
    expect(devanagariToHinglish("leke")).toBe("lekin");
    expect(devanagariToHinglish("apko")).toBe("aapko");
  });
});

describe("Phonetic Auto-Repair", () => {
  it("repairs acoustic phonetic mishearings", () => {
    expect(repairHinglishWord("prprprtee")).toBe("property");
    expect(repairHinglishWord("vestin")).toBe("Western");
    expect(repairHinglishWord("betrum")).toBe("bedroom");
    expect(repairHinglishWord("batrum")).toBe("bathroom");
    expect(repairHinglishWord("erya")).toBe("area");
  });

  it("leaves already canonical words untouched", () => {
    expect(repairHinglishWord("bedroom")).toBeUndefined();
    expect(repairHinglishWord("bathroom")).toBeUndefined();
    expect(repairHinglishWord("bungalow")).toBeUndefined();
    expect(repairHinglishWord("luxury")).toBeUndefined();
    expect(repairHinglishWord("property")).toBeUndefined();
  });
});

describe("Hinglish Post-Processing Pipeline", () => {
  it("processes a code-mixed Hinglish chunk into clean captions", async () => {
    const chunk: TranscriptChunk = {
      chunkIndex: 0,
      startMs: 0,
      endMs: 20200,
      words: [
        { s: 0, e: 800, t: "बारेश", wid: "0:0" },
        { s: 800, e: 980, t: "हो", wid: "0:1" },
        { s: 980, e: 1160, t: "रही", wid: "0:2" },
        { s: 1160, e: 1280, t: "है,", wid: "0:3" },
        { s: 1660, e: 2100, t: "बीग", wid: "0:4" },
        { s: 2100, e: 2300, t: "रहे", wid: "0:5" },
        { s: 2300, e: 2400, t: "है,", wid: "0:6" },
        { s: 2560, e: 2780, t: "लेके", wid: "0:7" },
        { s: 2780, e: 3200, t: "आपको", wid: "0:8" },
        { s: 3200, e: 3340, t: "ये", wid: "0:9" },
        { s: 3340, e: 3680, t: "बड़िया", wid: "0:10" },
        { s: 3680, e: 3800, t: "सा", wid: "0:11" },
        { s: 3800, e: 4080, t: "चार", wid: "0:12" },
        { s: 4080, e: 4400, t: "बेट्रुम,", wid: "0:13" },
        { s: 4460, e: 4660, t: "5", wid: "0:14" },
        { s: 4660, e: 5000, t: "bathroom,", wid: "0:15" },
        { s: 5120, e: 5460, t: "bungalow,", wid: "0:16" },
        { s: 5460, e: 5760, t: "दिखाईगे", wid: "0:17" },
        { s: 12520, e: 12860, t: "3", wid: "0:41" },
        { s: 12640, e: 12860, t: ",000", wid: "0:42" },
        { s: 12860, e: 13100, t: "square", wid: "0:43" },
        { s: 13100, e: 13460, t: "feet,", wid: "0:44" },
        { s: 17340, e: 18480, t: "अगर", wid: "0:50" },
        { s: 18480, e: 18860, t: "प्रप्रप्रटी", wid: "0:51" },
        { s: 18860, e: 18960, t: "ची", wid: "0:52" },
        { s: 18960, e: 19260, t: "अपको,", wid: "0:53" },
        { s: 19440, e: 19680, t: "ड़ाई", wid: "0:54" },
        { s: 19680, e: 19900, t: "करोड", wid: "0:55" },
        { s: 19900, e: 20020, t: "में", wid: "0:56" },
        { s: 20020, e: 20120, t: "मिले,", wid: "0:57" },
      ],
    };

    const result = await postProcess([chunk], {
      providerLanguage: "hi",
      hint: "hi-Latn",
      workspaceId: "test-ws",
    });

    expect(result.language.toLowerCase()).toBe("hi-latn");
    expect(result.scripts).toEqual(["roman", "native"]);

    const textList = result.chunks[0]!.words.map((w: Word) => w.t);
    expect(textList).toContain("baarish");
    expect(textList).toContain("bheeg");
    expect(textList).toContain("lekin");
    expect(textList).toContain("dikhayenge.");
    expect(textList).toContain("bedroom,");
    expect(textList).toContain("3,000");
    expect(textList).toContain("agar");
    expect(textList).toContain("property");
    expect(textList).toContain("chahiye");
    expect(textList).toContain("aapko,");
    expect(textList).toContain("dhaai");
    expect(textList).toContain("milegi,");
  });
});
