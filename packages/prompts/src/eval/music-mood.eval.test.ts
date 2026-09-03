/**
 * `music-mood@1` eval (D05 follow-up, brief §2): runs the deterministic mock
 * over every fixture transcript (brief §1's own fixture pack) and checks the
 * schema, index coverage and grounding invariants the real client's output
 * must also satisfy. Not part of `runEval`'s main `INSIGHT_KINDS` loop
 * (this template is not an "insight", the same way `keyphrases` sits outside
 * it) — a standalone eval, same shape as `templates.test.ts`'s per-schema
 * blocks.
 */
import { describe, expect, it } from "vitest";

import { FIXTURES } from "./fixtures.js";
import { mockMusicMood } from "./music-mood-mock.js";
import { musicMoodTemplate } from "../templates/music-mood.js";

describe("music-mood@1 eval", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.id}: mock output is schema-valid and covers every segment exactly once`, () => {
      const input = musicMoodTemplate.inputSchema.parse(fixture.transcript);
      const output = mockMusicMood(input);
      const parsed = musicMoodTemplate.outputSchema.safeParse(output);
      expect(parsed.success).toBe(true);

      const indices = output.scores.map((s) => s.index).sort((a, b) => a - b);
      expect(indices).toEqual(fixture.transcript.segments.map((_, i) => i));
      for (const score of output.scores) {
        expect(score.sentiment).toBeGreaterThanOrEqual(-1);
        expect(score.sentiment).toBeLessThanOrEqual(1);
      }
    });
  }

  it("is deterministic (same input -> byte-identical output)", () => {
    const fixture = FIXTURES[0];
    if (fixture === undefined) throw new Error("expected at least one fixture");
    const input = musicMoodTemplate.inputSchema.parse(fixture.transcript);
    expect(mockMusicMood(input)).toEqual(mockMusicMood(input));
  });

  it("scores a clearly positive sentence above a clearly negative one", () => {
    const input = musicMoodTemplate.inputSchema.parse({
      language: "en",
      durationMs: 8_000,
      segments: [
        { startMs: 0, endMs: 4_000, text: "This is the best and most amazing win ever" },
        { startMs: 4_000, endMs: 8_000, text: "This is terrible, the worst and saddest fail" },
      ],
    });
    const output = mockMusicMood(input);
    const positive = output.scores.find((s) => s.index === 0);
    const negative = output.scores.find((s) => s.index === 1);
    expect(positive?.sentiment).toBeGreaterThan(0);
    expect(negative?.sentiment).toBeLessThan(0);
  });
});
