import {
  VOICEOVER_LANGUAGE_NAMES,
  VOICEOVER_SPEAKERS,
  VOICEOVER_SPEAKER_NAMES,
  type VoiceoverLanguage,
  type VoiceoverSpeaker,
} from "@montaj/repurpose-contracts";

import { vendorLanguageOf } from "../dubbing/dub-languages.js";

/**
 * The product's language tags and the text-to-speech vendor's codes
 * (2026-10-01). The dubbing mapping (`../dubbing/dub-languages.ts`) already
 * reads every spelling the product uses - Hinglish is Hindi, `od` is Odia - so
 * this only moves its answer onto the speech API's spelling: Odia is `od-IN`
 * there, and Assamese is not spoken at all.
 */
export function voiceoverLanguageOf(tag: string | null | undefined): VoiceoverLanguage | null {
  const dub = vendorLanguageOf(tag);
  if (dub === null || dub === "as-IN") return null;
  return dub === "or-IN" ? "od-IN" : dub;
}

/** A language as the page shows it. */
export interface VoiceoverLanguageOption {
  readonly code: VoiceoverLanguage;
  readonly name: string;
}

export function voiceoverLanguageOption(code: VoiceoverLanguage): VoiceoverLanguageOption {
  // eslint-disable-next-line security/detect-object-injection -- a closed enum of codes
  return { code, name: VOICEOVER_LANGUAGE_NAMES[code] };
}

/** A voice as the page shows it. */
export interface VoiceoverSpeakerOption {
  readonly id: VoiceoverSpeaker;
  readonly name: string;
}

/** Every stock voice, in the vendor's order. */
export const VOICEOVER_SPEAKER_OPTIONS: readonly VoiceoverSpeakerOption[] = VOICEOVER_SPEAKERS.map(
  // eslint-disable-next-line security/detect-object-injection -- a closed enum of voices
  (id) => ({ id, name: VOICEOVER_SPEAKER_NAMES[id] }),
);
