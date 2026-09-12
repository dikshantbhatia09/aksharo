/**
 * The post-processing pipeline of `09 §3` (A11).
 *
 * Everything here is a pure function over words except {@link MemoryGlossarySource},
 * which is the one place a database is touched — see `glossary.source.ts` for why
 * the consent gate lives in the query rather than in a flag.
 */
export { POSTPROCESS_STEPS, unchanged, withText } from "./corrections.js";
export type { Correction, PostProcessStep, StepResult } from "./corrections.js";
export {
  lexiconFor,
  lexiconKeysFor,
  lexiconLanguages,
  normaliseToken,
  tagFillers,
} from "./fillers.js";
export type { FillerLexicon } from "./fillers.js";
export {
  applyGlossary,
  buildGlossaryIndex,
  EMPTY_GLOSSARY_SOURCE,
  MAX_GLOSSARY_DISTANCE,
} from "./glossary.js";
export type { GlossaryIndex, GlossarySource, GlossaryTerm } from "./glossary.js";
export { MAX_GLOSSARY_TERMS, MemoryGlossarySource } from "./glossary.source.js";
export { identifyLanguage, scriptSlots } from "./lid.js";
export type { DetectedLanguage, LanguageVerdict } from "./lid.js";
export {
  defaultNumeralParams,
  foldNumberRun,
  groupDigits,
  groupIndian,
  groupWestern,
  normaliseNumerals,
} from "./numerals.js";
export type { NumeralParams } from "./numerals.js";
export { editDistance, phoneticKey } from "./phonetic.js";
export { normaliseTimings, postProcess } from "./pipeline.js";
export type { PostProcessOptions, PostProcessResult } from "./pipeline.js";
export {
  defaultPunctuationParams,
  endsSentence,
  punctuate,
  restorePunctuation,
} from "./punctuation.js";
export type { PunctuationModel, PunctuationParams } from "./punctuation.js";
export { normaliseSpeakers } from "./speakers.js";
export type { SpeakerNormalisation } from "./speakers.js";
export { devanagariToHinglish } from "./transliterate.js";
export {
  CANONICAL_HINGLISH_VOCABULARY,
  repairHinglishWord,
  repairTranscriptWords,
} from "./repair.js";
