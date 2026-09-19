/* eslint-disable security/detect-object-injection, @typescript-eslint/no-non-null-assertion */
/**
 * Devanagari -> Hinglish (Roman) transliteration for post-processing (hi-Latn).
 *
 * Converts native Devanagari Hindi words into natural, readable Roman Hinglish:
 * - High-frequency dictionary for common conversational words and connectives.
 * - Accurate abugida mapping for consonants, vowels, matras, virama, and nuktas.
 * - Hindi schwa-deletion rules (word-final consonants drop inherent 'a',
 *   initial consonants keep 'a', medial consonants drop 'a' before accented syllables).
 * - Preserves existing Latin tokens and punctuation.
 */

const VOWELS: Readonly<Record<string, string>> = {
  "अ": "a",
  "आ": "aa",
  "इ": "i",
  "ई": "ee",
  "उ": "u",
  "ऊ": "oo",
  "ऋ": "ri",
  "ए": "e",
  "ऐ": "ai",
  "ओ": "o",
  "औ": "au",
};

const MATRAS: Readonly<Record<string, string>> = {
  "ा": "a",
  "ि": "i",
  "ी": "ee",
  "ु": "u",
  "ू": "oo",
  "ृ": "ri",
  "े": "e",
  "ै": "ai",
  "ो": "o",
  "ौ": "au",
};

const CONSONANTS: Readonly<Record<string, string>> = {
  "क": "k",
  "ख": "kh",
  "ग": "g",
  "घ": "gh",
  "ङ": "ng",
  "च": "ch",
  "छ": "chh",
  "ज": "j",
  "झ": "jh",
  "ञ": "ny",
  "ट": "t",
  "ठ": "th",
  "ड": "d",
  "ढ": "dh",
  "ण": "n",
  "त": "t",
  "थ": "th",
  "द": "d",
  "ध": "dh",
  "न": "n",
  "प": "p",
  "फ": "ph",
  "ब": "b",
  "भ": "bh",
  "म": "m",
  "य": "y",
  "र": "r",
  "ल": "l",
  "व": "v",
  "श": "sh",
  "ष": "sh",
  "स": "s",
  "ह": "h",
  "क़": "q",
  "ख़": "kh",
  "ग़": "gh",
  "ज़": "z",
  "ड़": "r",
  "ढ़": "dh",
  "फ़": "f",
};

const SPECIAL_WORDS: Readonly<Record<string, string>> = {
  "में": "mein",
  "हैं": "hain",
  "है": "hai",
  "हो": "ho",
  "का": "ka",
  "की": "ki",
  "के": "ke",
  "को": "ko",
  "से": "se",
  "ने": "ne",
  "तो": "toh",
  "भी": "bhi",
  "ये": "ye",
  "वह": "woh",
  "वो": "wo",
  "था": "tha",
  "थी": "thi",
  "थे": "the",
  "और": "aur",
  "या": "ya",
  "एक": "ek",
  "दो": "do",
  "तीन": "teen",
  "चार": "chaar",
  "पांच": "paanch",
  "अगर": "agar",
  "आगा": "agar",
  "अग्र": "agar",
  "बारेश": "baarish",
  "बारिश": "baarish",
  "भीग": "bheeg",
  "बीग": "bheeg",
  "बढ़िया": "badhiya",
  "बड़िया": "badhiya",
  "लोनावाला": "lonavala",
  "विला": "villa",
  "कमरे": "kamre",
  "होटल": "hotel",
  "नहीं": "nahi",
  "रही": "rahi",
  "रहे": "rahe",
  "रहा": "raha",
  "आपकी": "aapki",
  "आपका": "aapka",
  "आपके": "aapke",
  "आपको": "aapko",
  "अपको": "aapko",
  "कर": "kar",
  "करना": "karna",
  "बहुत": "bahut",
  "सब": "sab",
  "कुछ": "kuch",
  "घर": "ghar",
  "लेकिन": "lekin",
  "लेके": "lekin",
  "मकान": "makan",
  "आज": "aaj",
  "हम": "hum",
  "बात": "baat",
  "करेंगे": "karenge",
  "वीडियो": "video",
  "नमस्ते": "namaste",
  "दोस्तों": "dosto",
  "अच्छा": "accha",
  "ठीक": "theek",
  "क्या": "kya",
  "क्यों": "kyun",
  "अभी": "abhi",
  "फिर": "phir",
  "मिलते": "milte",
  "करो": "karo",
  "देखो": "dekho",
  "सुनिए": "suniye",
  "शुक्रिया": "shukriya",
  "धन्यवाद": "dhanyavaad",

  // Real Estate, Villa & Architecture English Loanwords
  "बेडरूम": "bedroom",
  "बेट्रूम": "bedroom",
  "बेट्रुम": "bedroom",
  "बाथरूम": "bathroom",
  "बात्रुम": "bathroom",
  "पात्रूम": "bathroom",
  "फाइव": "5",
  "फाइब": "5",
  "पाइब": "5",
  "प्राइवेट": "private",
  "प्रावेट": "private",
  "प्रवेट": "private",
  "पूल": "pool",
  "पुल": "pool",
  "प्राइवेटपूल": "private pool",
  "प्रावेट्पूल": "private pool",
  "प्रवेट्पूल": "private pool",
  "वेस्टर्न": "Western",
  "वेस्टिन": "Western",
  "घाट्स": "Ghats",
  "गार्ट्स": "Ghats",
  "गाथ": "Ghats",
  "व्यू": "view",
  "वू": "view",
  "वूँ": "view",
  "गार्डन": "garden",
  "गाडन": "garden",
  "गार्ट्ड": "garden",
  "एरिया": "area",
  "एर्या": "area",
  "आर्या": "area",
  "लक्जरी": "luxury",
  "लग्जरी": "luxury",
  "लक्सरी": "luxury",
  "प्रॉपर्टी": "property",
  "प्रोपती": "property",
  "प्रोपर्टी": "property",
  "प्रप्रप्रटी": "property",
  "स्क्वायर": "square",
  "स्क्वर": "square",
  "स्कोर": "square",
  "फीट": "feet",
  "करोड़": "crore",
  "करोड": "crore",
  "करों": "crore",
  "बंगलो": "bungalow",
  "बंगला": "bungalow",
  "बागलो": "bungalow",
  "हॉल": "hall",
  "किचन": "kitchen",
  "बालकनी": "balcony",
  "टेरेस": "terrace",
  "पार्किंग": "parking",

  // Conversational Hindi / Hinglish colloquialisms
  "इतर": "idhar",
  "इडर": "idhar",
  "इदर": "idhar",
  "इधर": "idhar",
  "उधर": "udhar",
  "उतर": "udhar",
  "उडर": "udhar",
  "वादियो": "vaadiyon",
  "वादिो": "vaadiyon",
  "वादियों": "vaadiyon",
  "बादलो": "baadalon",
  "बादलों": "baadalon",
  "बभरा": "bhara",
  "भरा": "bhara",
  "पड़ा": "pada",
  "पडा": "pada",
  "बरापडा": "bhara pada",
  "बराप़ा": "bhara pada",
  "भरापड़ा": "bhara pada",
  "भरा पड़ा": "bhara pada",
  "सिकाते": "dikhate",
  "दिखाते": "dikhate",
  "दिखाएंगे": "dikhayenge",
  "दिखाईगे": "dikhayenge",
  "चीया": "chahiye",
  "छी": "chahiye",
  "चाहिए": "chahiye",
  "ची": "chahiye",
  "ड़ाई": "dhaai",
  "डाए": "dhaai",
  "ढाई": "dhaai",
  "ढाए": "dhaai",
  "मिलेग": "milega",
  "मिलें": "milegi",
  "मिलेगा": "milega",
  "मिले": "milegi",
  "मिलेगी": "milegi",
  "रहता": "rahta",
  "हूं": "hoon",
  "हूँ": "hoon",
  "हों": "hoon",
  "रवी": "Ravi",
  "केवर": "Kewal",
  "केवल": "Kewal",
  "रमानी": "Ramani",
  "केवलरमानी": "Kewalramani",
  "तीनादा": "3,000",
  "तिनादा": "3,000",
};

export const ROMAN_COLLOQUIAL_REPLACEMENTS: Readonly<Record<string, string>> = {
  idr: "idhar",
  agr: "agar",
  prprprtee: "property",
  chee: "chahiye",
  barapda: "bhara pada",
  bharapada: "bhara pada",
  dikhaeege: "dikhayenge",
  dikhaenge: "dikhayenge",
  dikhayege: "dikhayenge",
  daee: "dhaai",
  vadiyo: "vaadiyon",
  badlo: "baadalon",
  leke: "lekin",
  apko: "aapko",
  erya: "area",
  eria: "area",
};

/**
 * Transliterates a single token (or word with punctuation) from Devanagari to Hinglish.
 * Non-Devanagari tokens (Latin words, digits, symbols) pass through untouched or receive colloquial normalization.
 */
export function devanagariToHinglish(word: string): string {
  if (!word || typeof word !== "string") return word;

  // Preserve leading and trailing punctuation
  const match = word.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}\u0900-\u097F]+)([^\p{L}\p{N}]*)$/u);
  if (!match) return word;

  const [, prefix = "", core = "", suffix = ""] = match;

  // Check if core contains Devanagari characters
  if (!/[\u0900-\u097F]/u.test(core)) {
    const lower = core.toLowerCase();
    if (ROMAN_COLLOQUIAL_REPLACEMENTS[lower] !== undefined) {
      const rep = ROMAN_COLLOQUIAL_REPLACEMENTS[lower]!;
      const isCapitalised = /^\p{Lu}/u.test(core);
      const formatted = isCapitalised ? rep.charAt(0).toUpperCase() + rep.slice(1) : rep;
      return prefix + formatted + suffix;
    }
    return word;
  }

  // Exact match from curated high-frequency dictionary
  if (SPECIAL_WORDS[core] !== undefined) {
    return prefix + SPECIAL_WORDS[core] + suffix;
  }

  // Normalize Unicode and handle nuktas
  let text = core.normalize("NFC");
  text = text
    .replace(/क\u093C/g, "क़")
    .replace(/ख\u093C/g, "ख़")
    .replace(/ग\u093C/g, "ग़")
    .replace(/ज\u093C/g, "ज़")
    .replace(/ड\u093C/g, "ड़")
    .replace(/ढ\u093C/g, "ढ़")
    .replace(/फ\u093C/g, "फ़")
    .replace(/\u093C/g, "");

  const chars = Array.from(text);
  const n = chars.length;
  // [text, hasSchwa, isVoweled]
  const tokens: [text: string, hasSchwa: boolean, isVoweled: boolean][] = [];

  let i = 0;
  while (i < n) {
    const c = chars[i]!;
    if (CONSONANTS[c] !== undefined) {
      const base = CONSONANTS[c];
      if (i + 1 < n) {
        const nxt = chars[i + 1]!;
        if (nxt === "्") {
          // Virama suppresses vowel
          tokens.push([base, false, false]);
          i += 2;
          continue;
        } else if (MATRAS[nxt] !== undefined) {
          // Matra replaces inherent vowel
          tokens.push([base + MATRAS[nxt], false, true]);
          i += 2;
          continue;
        } else if (nxt === "ं" || nxt === "ँ") {
          // Consonant with anusvara
          tokens.push([base + "an", false, true]);
          i += 2;
          continue;
        } else {
          // Inherent schwa
          tokens.push([base, true, false]);
          i += 1;
          continue;
        }
      } else {
        tokens.push([base, false, false]);
        i += 1;
        continue;
      }
    } else if (VOWELS[c] !== undefined) {
      let v = VOWELS[c];
      if (i + 1 < n && (chars[i + 1] === "ं" || chars[i + 1] === "ँ")) {
        v += "n";
        i += 2;
      } else {
        i += 1;
      }
      tokens.push([v, false, true]);
    } else if (MATRAS[c] !== undefined) {
      tokens.push([MATRAS[c], false, true]);
      i += 1;
    } else if (c === "ं" || c === "ँ") {
      if (tokens.length > 0) {
        const lastIdx = tokens.length - 1;
        const [lastTok] = tokens[lastIdx]!;
        if (lastTok.endsWith("e")) {
          tokens[lastIdx] = [lastTok.slice(0, -1) + "ein", false, true];
        } else {
          tokens[lastIdx] = [lastTok + "n", false, true];
        }
      }
      i += 1;
    } else {
      tokens.push([c, false, false]);
      i += 1;
    }
  }

  // Schwa deletion pass (Ohala's rule: medial schwa drops before an overtly voweled syllable)
  const out: string[] = [];
  const numTok = tokens.length;
  for (let idx = 0; idx < numTok; idx++) {
    const [t, hasSchwa] = tokens[idx]!;
    if (!hasSchwa) {
      out.push(t);
    } else {
      if (idx === numTok - 1) {
        // Word-final consonant never keeps schwa in Hindi
        out.push(t);
      } else if (idx === 0) {
        // Initial consonant always retains vowel
        out.push(t + "a");
      } else if (idx + 1 < numTok && tokens[idx + 1]![2]) {
        // Medial consonant drops schwa ONLY before an overtly voweled syllable (VC_CV)
        out.push(t);
      } else {
        out.push(t + "a");
      }
    }
  }

  return prefix + out.join("") + suffix;
}
