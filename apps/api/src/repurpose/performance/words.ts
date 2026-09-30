import type { HookStyle } from "@montaj/repurpose-contracts";

/**
 * A clip's words, as "What works" compares clips by them (2026-10-05): the
 * content words a title and hook share, and how the hook opens.
 *
 * The same rules as the highlights worker's (`apps/worker-ai/worker_ai/
 * highlights/performance.py`: `keywords`, `hook_style`), because what this
 * side finds did best is what that side lifts: a clip whose hook this reads as
 * a question must be a moment that side reads as a question. Both are tested
 * on the same examples.
 */

/** Words too common to say what a clip is about (four letters or more; three in Devanagari). */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "about", "actually", "after", "again", "also", "always", "another", "anything", "around",
  "because", "been", "before", "being", "come", "could", "didnt", "does", "doing", "done",
  "dont", "each", "even", "ever", "every", "from", "going", "gonna", "good", "have", "here",
  "into", "just", "kind", "know", "like", "little", "look", "make", "many", "maybe", "more",
  "most", "much", "need", "never", "okay", "only", "other", "over", "people", "really",
  "right", "said", "same", "should", "some", "something", "still", "such", "sure", "take",
  "talk", "tell", "than", "that", "thats", "their", "them", "then", "there", "these", "they",
  "thing", "think", "this", "those", "time", "very", "want", "well", "were", "what", "when",
  "where", "which", "while", "will", "with", "would", "yeah", "your", "youre",
  // Hinglish (Roman)
  "aapka", "aapke", "aapki", "abhi", "agar", "apna", "apne", "apni", "bahut", "bhai", "bilkul",
  "dekho", "dekhiye", "gaya", "gaye", "gayi", "haan", "hain", "hota", "hote", "hoti", "iska",
  "iske", "iski", "jaise", "kaha", "kahan", "kaise", "karein", "karen", "karna", "karne",
  "karo", "karta", "karte", "karti", "kitna", "kitne", "kiya", "kuch", "kyun", "kyunki",
  "lekin", "matlab", "mera", "mere", "meri", "nahi", "nahin", "phir", "raha", "rahe", "rahi",
  "sabse", "sirf", "tera", "teri", "unka", "unke", "unki", "uska", "uske", "uski", "wahi",
  "waise", "wala", "wale", "wali", "yaar", "yahi",
  // Hindi (Devanagari)
  "नहीं", "लेकिन", "क्योंकि", "बहुत", "सबसे", "अपना", "अपने", "अपनी", "मेरा", "मेरी", "मेरे",
  "हैं", "रहा", "रही", "रहे", "गया", "गयी", "गए", "वाला", "वाली", "वाले", "कैसे", "क्यों",
  "कौन", "कहाँ", "कितना", "सिर्फ", "बिल्कुल", "फिर", "अभी", "जैसे", "अगर", "भाई", "यार",
  "देखो", "करना", "करते", "करता", "करती", "किया", "होता", "होती", "होते", "कुछ", "इसके",
  "उसके", "उनके", "आपके", "हमारे",
]); // prettier-ignore

const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "what", "why", "how", "who", "when", "where", "which", "is", "are", "do", "does", "did",
  "can", "could", "should", "would", "will", "have", "has", "kya", "kyu", "kyun", "kaise",
  "kab", "kaun", "kahan", "kitna", "kitne", "kitni", "क्या", "क्यों", "कैसे", "कब", "कौन",
  "कहाँ", "कितना",
]); // prettier-ignore

const YOU_WORDS: ReadonlySet<string> = new Set([
  "you", "your", "youre", "yourself", "aap", "aapka", "aapke", "aapki", "tum", "tumhara",
  "tu", "tera", "आप", "आपका", "आपके", "तुम", "तुम्हारा",
]); // prettier-ignore

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "hundred",
  "thousand", "million", "lakh", "lakhs", "crore", "crores", "percent",
]); // prettier-ignore

const OPENING_WORDS = 10;
/** Runs of letters, marks and digits: a word in any script. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const ASCII = /^[\x20-\x7e]*$/;
const DIGITS = /^\p{N}+$/u;

/** Words, lower-cased (Python's `casefold` and JavaScript's `toLowerCase` agree on these scripts). */
function wordsOf(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(WORD) ?? [];
}

function fold(word: string): string {
  if (!ASCII.test(word)) return word;
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The content words of a text. */
export function contentWords(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of wordsOf(text)) {
    const folded = fold(word);
    if (DIGITS.test(folded)) continue;
    const minimum = ASCII.test(folded) ? 4 : 3;
    // Counted in code points, as Python counts a word.
    if ([...folded].length < minimum || STOPWORDS.has(folded) || STOPWORDS.has(word)) continue;
    found.add(folded);
  }
  return found;
}

/** How a text opens: a question, a number, the viewer addressed, or a statement. */
export function hookStyle(text: string): HookStyle {
  const words = wordsOf(text).slice(0, OPENING_WORDS);
  const first = words[0];
  if (first === undefined) return "statement";
  if (text.trim().slice(0, 160).includes("?") || QUESTION_OPENERS.has(first)) return "question";
  if (words.some((word) => DIGITS.test(word) || NUMBER_WORDS.has(word))) return "number";
  if (words.some((word) => YOU_WORDS.has(word))) return "you";
  return "statement";
}
