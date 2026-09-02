/**
 * Filler words per language, used by B18's autocut pass to decide what to cut
 * and by the transcript post-processor's `filler` flag (A11 §3). B11 owns
 * this file because it is prompt/eval-adjacent data that both a template
 * (avoiding fillers in generated titles) and B18 need, and a single source
 * avoids the two drifting.
 *
 * Language keys are BCP-47-ish tags matching `Transcript.language` (A11):
 * `en`, `hi`, `hi-Latn` (Hinglish, romanised Hindi mixed with English), `ta`.
 */
export const FILLER_LEXICON: Readonly<Record<string, readonly string[]>> = {
  en: ["um", "uh", "erm", "like", "you know", "i mean", "so yeah", "kind of", "sort of", "basically"],
  hi: ["मतलब", "यानी", "वो", "अरे", "हाँ तो", "क्या है ना"],
  "hi-Latn": ["matlab", "yaar", "toh", "vo", "haan toh", "kya hai na", "basically", "like"],
  ta: ["அப்படி", "என்னன்னா", "பாருங்க"],
} as const;

export function fillersFor(language: string): readonly string[] {
  return FILLER_LEXICON[language] ?? [];
}
