import { describe, expect, it } from "vitest";

import {
  EMOJI_TAXONOMY,
  filterEmojiPacing,
  getEmojiDataUri,
  getEmojiSvg,
  matchEmojiForWord,
  scanAndMatchTranscriptEmojis,
  stemWord,
} from "./index.js";

describe("Contextual Emoji Taxonomy & Matcher (Pillar 4 §04)", () => {
  it("accurately maps key emotional sentiments and high-impact terms to 3D emojis", () => {
    // Tests required by blueprint SLA: millionaire, fired, exploded, crying
    const millionaire = matchEmojiForWord("millionaire");
    expect(millionaire).not.toBeNull();
    expect(millionaire?.emoji).toBe("💸");
    expect(millionaire?.assetSvg).toBe("3d-money-wings.svg");

    const fired = matchEmojiForWord("fired");
    expect(fired).not.toBeNull();
    expect(fired?.emoji).toBe("🔥");
    expect(fired?.assetSvg).toBe("3d-fire.svg");

    const exploded = matchEmojiForWord("exploded");
    expect(exploded).not.toBeNull();
    expect(exploded?.emoji).toBe("🚀");

    const crying = matchEmojiForWord("crying");
    expect(crying).not.toBeNull();
    expect(crying?.emoji).toBe("😭");
    expect(crying?.assetSvg).toBe("3d-crying.svg");

    // Other core emotional words
    expect(matchEmojiForWord("rocket")?.emoji).toBe("🚀");
    expect(matchEmojiForWord("revenue")?.emoji).toBe("💸");
    expect(matchEmojiForWord("growth")?.emoji).toBe("📈");
    expect(matchEmojiForWord("mindblown")?.emoji).toBe("🤯");
    expect(matchEmojiForWord("danger")?.emoji).toBe("⚠️");
    expect(matchEmojiForWord("died")?.emoji).toBe("💀");
    expect(matchEmojiForWord("trophy")?.emoji).toBe("🏆");
    expect(matchEmojiForWord("strong")?.emoji).toBe("💪");
  });

  it("handles morphological inflections and punctuation stripping", () => {
    expect(matchEmojiForWord("SCALED!")?.emoji).toBe("🚀");
    expect(matchEmojiForWord('"FIRE"')?.emoji).toBe("🔥");
    expect(matchEmojiForWord("cried...")?.emoji).toBe("😭");
    expect(matchEmojiForWord("stops")?.emoji).toBe("🛑");
    expect(matchEmojiForWord("warnings")?.emoji).toBe("⚠️");
  });

  it("stems words accurately into possible root candidates", () => {
    const stems = stemWord("investments");
    expect(stems).toContain("investment");

    const scalingStems = stemWord("scaling");
    expect(scalingStems).toContain("scale");
  });

  it("pacing test: throttles 10 consecutive emotional words to enforce >= 2.8s spacing", () => {
    // 10 emotional words every 500ms (0s, 0.5s, 1.0s, 1.5s, 2.0s, 2.5s, 3.0s, 3.5s, 4.0s, 4.5s)
    const consecutiveWords = [
      { id: "w1", text: "money", startMs: 0 },
      { id: "w2", text: "fire", startMs: 500 },
      { id: "w3", text: "rocket", startMs: 1000 },
      { id: "w4", text: "crying", startMs: 1500 },
      { id: "w5", text: "growth", startMs: 2000 },
      { id: "w6", text: "insane", startMs: 2500 },
      { id: "w7", text: "profit", startMs: 3000 },
      { id: "w8", text: "exploded", startMs: 3500 },
      { id: "w9", text: "dead", startMs: 4000 },
      { id: "w10", text: "target", startMs: 4500 },
    ];

    const matched = scanAndMatchTranscriptEmojis(consecutiveWords, 2800);

    // Only words with startMs >= 2800ms gap should pass:
    // w1 at 0ms is accepted.
    // w2..w6 (500ms..2500ms) are dropped.
    // w7 at 3000ms is >= 2800ms from 0ms, so w7 is accepted.
    // w8..w10 (3500ms..4500ms) are < 3000 + 2800 = 5800ms, so dropped.
    expect(matched.length).toBe(2);
    expect(matched[0]?.text).toBe("money");
    expect(matched[0]?.startMs).toBe(0);
    expect(matched[1]?.text).toBe("profit");
    expect(matched[1]?.startMs).toBe(3000);
  });

  it("retrieves scalable 3D vector SVG strings and valid data URIs", () => {
    const fireSvg = getEmojiSvg("fire");
    expect(fireSvg).not.toBeNull();
    expect(fireSvg).toContain("<svg");
    expect(fireSvg).toContain("viewBox=\"0 0 128 128\"");

    const fireDataUri = getEmojiDataUri("3d-fire.svg");
    expect(fireDataUri).not.toBeNull();
    expect(fireDataUri).toMatch(/^data:image\/svg\+xml/);

    const rocketSvg = getEmojiSvg("rocket");
    expect(rocketSvg).toContain("<svg");

    const unknown = getEmojiSvg("non-existent-xyz");
    expect(unknown).toBeNull();
  });

  it("satisfies SLA: maps 500 transcript words in under 10ms (SLA <= 80ms)", () => {
    const vocabulary = ["the", "quick", "brown", "fox", "made", "millions", "revenue", "and", "fired", "the", "rocket"];
    const mockTranscript = Array.from({ length: 500 }, (_, i) => ({
      wid: `0:${i}`,
      t: vocabulary[i % vocabulary.length]!,
      s: i * 200,
      e: i * 200 + 180,
    }));

    const start = performance.now();
    const result = scanAndMatchTranscriptEmojis(mockTranscript, 2800);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(80); // Strict SLA <= 80ms
    expect(result.length).toBeGreaterThan(0);
  });
});
