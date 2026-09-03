/**
 * The fake/mock provider for `music-mood@1` (brief §2/§6: "deterministic
 * mock in tests"). Scores each segment with the same tiny positive/negative
 * word-count lexicon `worker_ai.passes.music.sentiment`'s offline fallback
 * uses — deterministic, no network, and grounded (every score is derived
 * only from the segment's own words), matching every other mock generator
 * in this package.
 *
 * `worker_ai/llm/providers/mock.py`'s `_music_mood` mirrors this scorer
 * exactly (same word lists, same clamp) so the two mocks agree.
 */
import type { MusicMoodInput, MusicMoodOutput } from "../templates/music-mood.js";

const POSITIVE_WORDS = new Set([
  "great",
  "amazing",
  "love",
  "awesome",
  "happy",
  "exciting",
  "fun",
  "best",
  "win",
  "yes",
]);
const NEGATIVE_WORDS = new Set([
  "bad",
  "sad",
  "hate",
  "terrible",
  "worst",
  "fail",
  "no",
  "angry",
  "afraid",
  "wrong",
]);

function scoreText(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return 0;
  let score = 0;
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) score += 1;
    if (NEGATIVE_WORDS.has(word)) score -= 1;
  }
  return Math.max(-1, Math.min(1, score / Math.max(3, words.length)));
}

export function mockMusicMood(input: MusicMoodInput): MusicMoodOutput {
  return {
    scores: input.segments.map((segment, index) => ({
      index,
      sentiment: Math.round(scoreText(segment.text) * 1000) / 1000,
    })),
  };
}
