import type { Word } from "@montaj/edg/schemas";
import { withText } from "./corrections.js";
import { editDistance, phoneticKey } from "./phonetic.js";
import type { Correction, StepResult } from "./corrections.js";
import { ROMAN_COLLOQUIAL_REPLACEMENTS } from "./transliterate.js";

/**
 * High-frequency canonical Hinglish vocabulary across major video creator domains:
 * Conversational, Real Estate, Tech, Digital Media, and Business.
 */
export const CANONICAL_HINGLISH_VOCABULARY: readonly string[] = [
  // Conversational Hindi / Hinglish core
  "agar", "magar", "lekin", "kyunki", "isliye", "chahiye", "aapko", "aapka", "aapke",
  "aapki", "hum", "humein", "hamara", "hamare", "hamari", "tum", "tumhe", "tumhara",
  "mujhe", "mera", "mere", "meri", "karenge", "karna", "karte", "karo", "dekhenge",
  "dekhna", "dekho", "suniye", "bolenge", "bolna", "bolo", "batayenge", "batana",
  "dikhayenge", "dikhana", "milenge", "milna", "milegi", "milega", "rahenge", "rahna",
  "raha", "rahe", "rahi", "hota", "hote", "hoti", "hoga", "hogi", "honge",
  "accha", "theek", "badhiya", "sahi", "galat", "pakka", "zaroor", "shuru", "khatam",
  "bohot", "bahut", "thoda", "zyada", "kam", "waapas", "koshish", "pehla", "doosra",
  "baarish", "bheeg", "idhar", "udhar", "yahan", "wahan", "kahan", "jahan",
  "vaadiyon", "baadalon", "bhara", "pada", "dhaai", "dedh", "sawa", "paune",
  "shukriya", "dhanyavaad", "namaste", "dosto", "bhai", "yaar", "matlab",
  "paas", "saath", "baad", "pehle", "aaj", "kal", "abhi", "kabhi", "sab", "sabka",
  "sabke", "sabki", "kuch", "koi", "kaun", "kya", "kyun", "kaise", "apna", "apne",
  "apni", "naam", "baat", "log", "bhi", "toh", "hai", "hain", "tha", "the", "thi",
  "kar", "diya", "diye", "di", "liya", "liye", "li", "gaya", "gaye", "gayi",
  "aaya", "aaye", "aayi", "sirf", "bas",

  // Real Estate, Architecture & Interior
  "bedroom", "bathroom", "master bedroom", "living room", "dining area", "kitchen",
  "modular kitchen", "balcony", "terrace", "private pool", "swimming pool", "garden",
  "garden area", "lawn", "deck", "parking", "covered parking", "clubhouse", "gym",
  "amenities", "carpet area", "super built-up", "built-up", "square feet", "acres",
  "bigha", "gaj", "bungalow", "villa", "penthouse", "duplex", "triplex", "luxury property",
  "commercial", "residential", "plot", "flat", "apartment", "studio apartment",
  "Western Ghats", "sea view", "mountain view", "valley view", "Lonavala", "Alibaug",
  "Goa", "Mumbai", "Pune", "Bangalore", "Delhi", "Gurgaon", "Noida",
  "builder", "developer", "possession", "ready to move", "under construction",
  "registry", "stamp duty", "crore", "lakh", "hazaar",

  // Tech, Creators, Digital Media
  "video", "channel", "subscribe", "notification", "link", "description", "instagram",
  "youtube", "reel", "short", "content", "creator", "vlog", "vlogger", "podcast",
  "interview", "episode", "stream", "followers", "subscribers", "trending", "viral",
  "algorithm", "website", "application", "mobile", "laptop", "desktop", "camera",
  "microphone", "setup", "studio", "lighting", "quality", "resolution",

  // Business, Commerce & Finance
  "budget", "price", "cost", "offer", "deal", "discount", "negotiable", "market",
  "investment", "investor", "returns", "profit", "startup", "business", "company",
  "client", "customer", "payment", "cash", "cheque", "online", "loan", "interest", "down payment",
];

const ALL_CANONICAL_TERMS: readonly string[] = (() => {
  const terms = new Set<string>();
  for (const item of CANONICAL_HINGLISH_VOCABULARY) {
    terms.add(item);
    for (const part of item.split(/\s+/)) {
      if (part.length >= 3) {
        terms.add(part);
      }
    }
  }
  return Array.from(terms);
})();

interface CanonicalEntry {
  readonly canonical: string;
  readonly key: string;
  readonly lower: string;
}

const CANONICAL_INDEX: readonly CanonicalEntry[] = ALL_CANONICAL_TERMS.map((term) => ({
  canonical: term,
  key: phoneticKey(term),
  lower: term.toLowerCase(),
}));

const CANONICAL_SET: ReadonlySet<string> = new Set(
  ALL_CANONICAL_TERMS.map((w) => w.toLowerCase()),
);

/**
 * Strips punctuation to evaluate bare word.
 */
function cleanWord(text: string): { prefix: string; core: string; suffix: string } {
  const match = text.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}]+)([^\p{L}\p{N}]*)$/u);
  if (!match) return { prefix: "", core: text, suffix: "" };
  return { prefix: match[1] ?? "", core: match[2] ?? "", suffix: match[3] ?? "" };
}

/**
 * Phonetically repairs corrupted Hinglish words using consonant skeleton matching
 * and Levenshtein edit distance.
 */
export function repairHinglishWord(text: string): string | undefined {
  const { prefix, core, suffix } = cleanWord(text);
  if (!core || core.length < 3) return undefined;

  const lower = core.toLowerCase();

  // 1. Direct colloquial / corrupted Roman replacement lookup
  if (ROMAN_COLLOQUIAL_REPLACEMENTS[lower] !== undefined) {
    const rep = ROMAN_COLLOQUIAL_REPLACEMENTS[lower]!;
    const isCapitalised = /^\p{Lu}/u.test(core);
    const formatted = isCapitalised ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep;
    return prefix + formatted + suffix;
  }

  // If word is already standard canonical Hinglish/English, leave untouched
  if (CANONICAL_SET.has(lower)) return undefined;

  const key = phoneticKey(core);
  if (!key) return undefined;

  let bestMatch: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const entry of CANONICAL_INDEX) {
    // Exact or near phonetic key match
    const keyDist = editDistance(key, entry.key, 2);
    if (keyDist > 1) continue;

    const charDist = editDistance(lower, entry.lower, 3);
    const isCoreVowel = /^[aeiou]/i.test(core);
    const isEntryVowel = /^[aeiou]/i.test(entry.canonical);
    const onsetMismatch = isCoreVowel !== isEntryVowel ? 2 : 0;
    const score = keyDist * 3 + charDist + onsetMismatch;

    // For short words (<= 4 chars), require identical consonant skeleton if charDist > 1
    if (entry.lower.length <= 4 && keyDist > 0 && charDist > 1) continue;

    // Must be plausible given word length
    const maxAllowedDist = Math.max(2, Math.floor(entry.lower.length * 0.45));
    if (charDist <= maxAllowedDist && score < bestScore) {
      bestScore = score;
      bestMatch = entry.canonical;
    }
  }

  if (bestMatch !== undefined) {
    const isCapitalised = /^\p{Lu}/u.test(core);
    const formatted = isCapitalised
      ? bestMatch.charAt(0).toUpperCase() + bestMatch.slice(1)
      : bestMatch;
    return prefix + formatted + suffix;
  }

  return undefined;
}

/**
 * Automated phonetic repair pass over transcript words for Hinglish transcripts.
 */
export function repairTranscriptWords(words: readonly Word[]): StepResult {
  const corrections: Correction[] = [];
  const out: Word[] = [];

  for (const word of words) {
    // Only repair Roman/Latin words (Devanagari is handled by transliteration)
    if (!/[\u0900-\u097F]/u.test(word.t)) {
      const repaired = repairHinglishWord(word.t);
      if (repaired !== undefined && repaired !== word.t) {
        corrections.push({
          step: "glossary",
          wordId: word.wid,
          before: word.t,
          after: repaired,
          reason: "hinglish phonetic repair",
        });
        out.push(withText(word, repaired));
        continue;
      }
    }
    out.push(word);
  }

  return { words: out, corrections };
}
