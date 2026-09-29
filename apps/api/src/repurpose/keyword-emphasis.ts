/**
 * Which words of a caption to emphasise (Autopilot's finishing pass,
 * 2026-09-29): the keyword highlight the reader's eye lands on, the look the
 * clip tools that lead this market ship by default.
 *
 * One word per caption, two when a long caption also carries a number or a
 * name. Numbers first (a stat is the hook of most lines: "5 tarike", "₹10
 * lakh"), then names (a capital that does not start a sentence), then the
 * longest word that carries meaning. Words that carry none are never picked:
 * the English, Hinglish and Hindi function words below, fillers, and anything
 * shorter than three letters that is not a number.
 *
 * Pure and deterministic: the same words always give the same picks, so a
 * reconcile that runs twice writes the same emphasis twice.
 */

/** A transcript word as the finishing pass reads it. */
export interface EmphasisCandidate {
  readonly wid: string;
  readonly t: string;
  readonly filler?: boolean;
}

/** Splits a whitespace-separated word list: one list per language, easy to extend. */
function wordSet(...lists: readonly string[]): ReadonlySet<string> {
  return new Set(lists.flatMap((list) => list.split(/\s+/u).filter((word) => word !== "")));
}

const ENGLISH_STOPWORDS = `
  a an the and or but so if then than of to in on at by for with from as into about over out
  up down is are was were be been being am do does did done have has had will would can could
  should shall may might must it its it's this that these those there here i i'm me my we our
  you your you're he she him her his they them their what which who whom how why when where not
  no yes very really just also too all any some more most like get got go going gonna wanna want
  know think say said okay ok yeah right actually basically literally thing things don't didn't
  can't isn't that's there's let let's`;

const HINGLISH_STOPWORDS = `
  hai hain ho hota hoti hote tha thi the ka ki ke ko se me mein mai main toh to na nahi nahin nai
  bhi hi ye yeh wo woh vo voh jo kya kaise kyun kyon kyu aur par pe ab aap tum hum mera meri mere
  tera teri tere apna apni apne uska uski uske iska iski iske unka unki unke kuch sab bahut bohot
  bohat bas agar lekin magar fir phir raha rahi rahe gaya gayi gaye kar karo karna karke karte
  karta karti diya liya de le ja jaa haan han ha ji bhai yaar yar matlab accha acha achha theek
  thik wala wali wale abhi kab jab tab yahan wahan idhar udhar koi kisi kis sirf hua hui hue gya gyi
  sabse`;

const HINDI_STOPWORDS = `
  है हैं हो होता होती होते था थी थे का की के को से में मैं मे तो ना न नहीं भी ही ये यह वो वह जो
  क्या कैसे क्यों और पर अब आप तुम हम मेरा मेरी मेरे तेरा तेरी तेरे अपना अपनी अपने उसका उसकी उसके
  इसका इसकी इसके कुछ सब बहुत बस अगर लेकिन मगर फिर रहा रही रहे गया गई गए कर करो करना करके करते
  दिया लिया दे ले जा हाँ हां जी भाई यार मतलब अच्छा ठीक वाला वाली वाले अभी जब तब यहाँ वहाँ कोई किसी
  सिर्फ हुआ हुई हुए सबसे`;

/** Function words in English, romanised Hindi (Hinglish) and Devanagari: never a keyword. */
const STOPWORDS = wordSet(ENGLISH_STOPWORDS, HINGLISH_STOPWORDS, HINDI_STOPWORDS);

/** Number words, so "paanch tarike" and "पाँच तरीके" count as the stat they are. */
const NUMBER_WORDS = wordSet(`
  one two three four five six seven eight nine ten hundred thousand million billion lakh lakhs
  crore crores ek teen char chaar paanch panch chhe saat aath nau das sau hazaar hazar hajar
  एक दो तीन चार पांच पाँच छह सात आठ नौ दस सौ हज़ार हजार लाख करोड़`);

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}\p{M}₹$€£%]+|[^\p{L}\p{N}\p{M}₹$€£%]+$/gu;
const SENTENCE_END = /[.?!।]["')\]]*$/u;

/** The word as compared: edge punctuation off, lower case (a no-op for Devanagari). */
export function normaliseWord(text: string): string {
  return text.replace(EDGE_PUNCTUATION, "").toLowerCase();
}

/**
 * How long a word looks: its code points, less the ones that take no space of
 * their own — the Devanagari virama and nukta, and the joiners. A vowel sign
 * does take space, so "ज़रूरी" is longer than "आदत", as it reads.
 */
const NO_WIDTH: ReadonlySet<string> = new Set(["\u093C", "\u094D", "\u200C", "\u200D", "\uFE0F"]);

function letters(text: string): number {
  let count = 0;
  for (const character of text) if (!NO_WIDTH.has(character)) count += 1;
  return count;
}

function isNumber(word: string): boolean {
  return /\p{N}/u.test(word) || /[₹$€£%]/u.test(word) || NUMBER_WORDS.has(word);
}

/** A capital in the middle of a sentence: a name, a brand, a place. */
function isName(text: string, previous: string | undefined): boolean {
  const cleaned = text.replace(EDGE_PUNCTUATION, "");
  const first = cleaned.charAt(0);
  if (first === "" || !/\p{Lu}/u.test(first)) return false;
  // An all-caps word is shouting (or a caption style), not a name.
  if (cleaned.length > 1 && cleaned === cleaned.toUpperCase()) return false;
  return previous !== undefined && !SENTENCE_END.test(previous);
}

/**
 * The words of one caption worth emphasising, best first, as word ids: one,
 * or two when the caption is long and the second is a number or a name.
 * Empty when nothing in it carries meaning.
 */
export function chooseEmphasis(words: readonly EmphasisCandidate[]): string[] {
  const scored: { wid: string; score: number; index: number }[] = [];
  for (const [index, word] of words.entries()) {
    if (word.filler === true) continue;
    const normalised = normaliseWord(word.t);
    if (normalised === "" || STOPWORDS.has(normalised)) continue;
    const number = isNumber(normalised);
    if (!number && letters(normalised) < 3) continue;
    let score: number;
    if (number) score = 5;
    // `at(-1)` would wrap round to the last word: the first has no previous.
    else if (isName(word.t, index === 0 ? undefined : words.at(index - 1)?.t)) score = 3;
    else score = 1 + Math.min(letters(normalised), 12) / 12;
    scored.push({ wid: word.wid, score, index });
  }
  if (scored.length === 0) return [];
  // Best first; between equals, the earlier word — it is read first.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const [best, second] = scored;
  if (best === undefined) return [];
  const picks = [best.wid];
  if (second !== undefined && second.score >= 3 && scored.length >= 4) picks.push(second.wid);
  return picks;
}
