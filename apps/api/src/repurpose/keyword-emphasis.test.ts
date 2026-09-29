import { describe, expect, it } from "vitest";

import { chooseEmphasis, normaliseWord } from "./keyword-emphasis.js";

/** `"a b c"` → words with ids `w0`, `w1`, ... */
function words(text: string, fillers: readonly number[] = []) {
  return text.split(" ").map((t, index) => ({
    wid: `w${String(index)}`,
    t,
    ...(fillers.includes(index) ? { filler: true } : {}),
  }));
}

describe("chooseEmphasis", () => {
  it("picks the number in a caption first: digits, money, and number words", () => {
    expect(chooseEmphasis(words("sabse important ye 3 cheezein hain"))).toEqual(["w3"]);
    // "₹10 lakh" reads as one figure, and both halves of it are numbers.
    expect(chooseEmphasis(words("usne kamaye ₹10 lakh ek saal mein"))).toEqual(["w2", "w3"]);
    expect(chooseEmphasis(words("bas paanch minute lagte hain"))).toEqual(["w1"]);
    expect(chooseEmphasis(words("सिर्फ पाँच मिनट लगते हैं"))).toEqual(["w1"]);
  });

  it("picks a name in the middle of a sentence, never a capital that starts one", () => {
    expect(chooseEmphasis(words("maine socha ki Mumbai jaana chahiye"))).toEqual(["w3"]);
    expect(chooseEmphasis(words("Dekho. Yahan pe sab kuch hai"))).not.toContain("w1");
  });

  it("otherwise picks the longest word that carries meaning, never a function word", () => {
    expect(chooseEmphasis(words("ye toh bahut hi zabardast idea hai"))).toEqual(["w4"]);
    expect(chooseEmphasis(words("this is the most underrated habit"))).toEqual(["w4"]);
    expect(chooseEmphasis(words("यह सबसे ज़रूरी आदत है"))).toEqual(["w2"]);
  });

  it("adds a second keyword only to a long caption, and only a number or a name", () => {
    // A capital that opens the caption is not taken for a name.
    expect(chooseEmphasis(words("Virat ne kal 50 run banaye aur match jita diya"))).toEqual(["w3"]);
    expect(chooseEmphasis(words("kal Virat ne 50 run banaye aur match jitaya"))).toEqual([
      "w3",
      "w1",
    ]);
    expect(chooseEmphasis(words("kal 50 run banaye"))).toEqual(["w1"]);
  });

  it("never picks a filler, and finds nothing in a caption of function words", () => {
    expect(chooseEmphasis(words("umm basically everything changed", [0]))).toEqual(["w2"]);
    expect(chooseEmphasis(words("toh hai na bhai"))).toEqual([]);
    expect(chooseEmphasis([])).toEqual([]);
  });
});

describe("normaliseWord", () => {
  it("strips punctuation at the edges and lower-cases, keeping money and marks", () => {
    expect(normaliseWord("“Mumbai,”")).toBe("mumbai");
    expect(normaliseWord("₹10!")).toBe("₹10");
    expect(normaliseWord("पैसे।")).toBe("पैसे");
  });
});
