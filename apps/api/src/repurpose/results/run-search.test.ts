import { describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { RunSearch, cosine, isLoopback, matchesOf, momentText, ollamaRoot } from "./run-search.js";

import type { PrismaService } from "../../common/index.js";
import type { RedisService } from "../../common/redis/redis.service.js";

const MOMENTS = [
  {
    id: "MONEY",
    title: "The eighth wonder",
    transcriptExcerpt: "Compound interest grows your savings while you sleep.",
    copy: { hook: "Nobody tells you this about money", hashtags: ["#money", "#investing"] },
    judgement: { people: ["Warren Buffett"] },
  },
  {
    id: "LOVE",
    title: "Why confidence is quiet",
    transcriptExcerpt: "Insecure people focus on themselves.",
    copy: {},
    judgement: null,
  },
];

/** Vectors by topic: money-ish texts point one way, the rest another. */
function fakeEmbed(texts: readonly string[]): number[][] {
  return texts.map((text) => (/money|saving|invest|interest|rich/i.test(text) ? [1, 0.1] : [0, 1]));
}

function harness(options: { readonly baseUrl?: string } = {}) {
  const cache = new Map<string, string>();
  const redis = {
    client: {
      mget: async (...keys: string[]) => keys.map((key) => cache.get(key) ?? null),
      multi: () => {
        const sets: [string, string][] = [];
        const chain = {
          set: (key: string, value: string) => {
            sets.push([key, value]);
            return chain;
          },
          exec: async () => {
            for (const [key, value] of sets) cache.set(key, value);
            return [];
          },
        };
        return chain;
      },
    },
  } as unknown as RedisService;
  const prisma = {
    clipCandidate: { findMany: vi.fn(async () => MOMENTS) },
  } as unknown as PrismaService;
  const env = { LLM_BASE_URL: options.baseUrl ?? "http://127.0.0.1:11434/v1" } as unknown as Env;
  const search = new RunSearch(prisma, redis, env);
  const embedder = vi.fn(async (texts: readonly string[]) => fakeEmbed(texts));
  search.embedder = embedder;
  return { search, embedder, cache, prisma };
}

describe("momentText", () => {
  it("is everything a moment is about: title, hook, topics, people and words", () => {
    expect(momentText(MOMENTS[0] as Parameters<typeof momentText>[0])).toBe(
      "The eighth wonder. Nobody tells you this about money. money, investing. Warren Buffett. Compound interest grows your savings while you sleep.",
    );
  });
});

describe("cosine, ollamaRoot and isLoopback", () => {
  it("measure closeness, find the server's root and keep text on this machine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(ollamaRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(isLoopback("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopback("http://localhost:11434")).toBe(true);
    expect(isLoopback("https://api.openai.com")).toBe(false);
  });
});

describe("matchesOf", () => {
  const scores = (values: readonly number[]) =>
    values.map((score, index) => ({ candidateId: `C${String(index)}`, score }));

  it("answers with the moments near the best when the best stands clear of the rest", () => {
    // "firing employees" on the owner's podcast run.
    expect(matchesOf(scores([0.644, 0.503, 0.503, 0.483, 0.42, 0.4, 0.38, 0.304]))).toEqual([
      { candidateId: "C0", score: 0.644 },
    ]);
    // "selling to the government": two close ones, both kept.
    expect(
      matchesOf(scores([0.491, 0.477, 0.45, 0.418, 0.39, 0.37, 0.36, 0.236])).map((m) => m.score),
    ).toEqual([0.491, 0.477]);
  });

  it("answers nothing for a question the video is not about", () => {
    // "cooking recipes": nothing near the line.
    expect(matchesOf(scores([0.415, 0.399, 0.394, 0.389, 0.36, 0.3, 0.238]))).toEqual([]);
    // A Hindi question about saving money: over the line, but no clearer than the rest.
    expect(matchesOf(scores([0.523, 0.523, 0.489, 0.487, 0.47, 0.46, 0.45, 0.34]))).toEqual([]);
  });
});

describe("RunSearch", () => {
  it("finds a moment by what it is about, though no word matches", async () => {
    const h = harness();
    const result = await h.search.search("RUN", "how do I get rich");
    expect(result.semantic).toBe(true);
    expect(result.matches.map((match) => match.candidateId)).toEqual(["MONEY"]);
    expect(h.prisma.clipCandidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "RUN", state: { not: "rejected" } } }),
    );
  });

  it("embeds each moment once, then reads it from the cache", async () => {
    const h = harness();
    await h.search.search("RUN", "how do I get rich");
    expect(h.embedder).toHaveBeenLastCalledWith(expect.arrayContaining(["how do I get rich"]));
    expect(h.embedder.mock.calls.at(-1)?.[0]).toHaveLength(3);
    await h.search.search("RUN", "saving money");
    // Only the new question is embedded the second time.
    expect(h.embedder.mock.calls.at(-1)?.[0]).toEqual(["saving money"]);
  });

  it("says it cannot read the meaning when the model is not there, rather than failing", async () => {
    const h = harness();
    h.search.embedder = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await h.search.search("RUN", "money")).toEqual({ semantic: false, matches: [] });
  });

  it("never sends what is said to a server that is not this machine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const h = harness({ baseUrl: "https://api.example-llm.com/v1" });
    // The real embedder, not the test's.
    h.search.embedder = (texts) =>
      (
        h.search as unknown as { embedLocally: (t: readonly string[]) => Promise<number[][]> }
      ).embedLocally(texts);
    expect(await h.search.search("RUN", "money")).toEqual({ semantic: false, matches: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
