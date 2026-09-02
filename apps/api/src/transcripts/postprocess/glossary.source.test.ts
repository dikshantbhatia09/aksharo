import { describe, expect, it, vi } from "vitest";

import { MAX_GLOSSARY_TERMS, MemoryGlossarySource } from "./glossary.source.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";

const WS = "01JCWS0000000000000000000A";

interface Row {
  id: string;
  kind: string;
  value: unknown;
}

function source(rows: Row[]): {
  reader: MemoryGlossarySource;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async () => rows);
  const reader = new MemoryGlossarySource({
    memoryEntry: { findMany },
  } as unknown as PrismaService);
  return { reader, findMany };
}

/**
 * The consent gate is the **query**, not a flag — so the query itself is what
 * this suite pins. A change that drops the `consent` clause makes a test fail
 * rather than quietly widening what the product remembers about a user (D61/D62).
 */
describe("MemoryGlossarySource", () => {
  it("asks only for unexpired entries under a live memory grant, in one workspace", async () => {
    const { reader, findMany } = source([]);
    await reader.terms(WS);

    const where = findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where["workspaceId"]).toBe(WS);
    expect(where["consent"]).toEqual({
      purpose: "memory",
      granted: true,
      withdrawnAt: null,
    });
    expect((where["expiresAt"] as { gt: Date }).gt).toBeInstanceOf(Date);
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(MAX_GLOSSARY_TERMS);
  });

  it("reads a term from any of the shapes B09 might store", async () => {
    const { reader } = source([
      { id: "1", kind: "glossary", value: { term: "Aksharo" } },
      { id: "2", kind: "spelling", value: { text: "Bharat" } },
      { id: "3", kind: "name_spelling", value: "प्रियंका" },
      { id: "4", kind: "glossary_term", value: { correct: "Sarvam" } },
    ]);

    expect(await reader.terms(WS)).toEqual([
      { term: "Aksharo", source: "glossary" },
      { term: "Bharat", source: "spelling" },
      { term: "प्रियंका", source: "spelling" },
      { term: "Sarvam", source: "glossary" },
    ]);
  });

  it("carries the spellings the user was actually heard saying", async () => {
    const { reader } = source([
      { id: "1", kind: "spelling", value: { term: "Aksharo", heard: ["Akshara", "Achsharo"] } },
      { id: "2", kind: "glossary", value: { term: "Sarvam", variants: ["Sarwam"] } },
    ]);

    expect(await reader.terms(WS)).toEqual([
      { term: "Aksharo", aliases: ["Akshara", "Achsharo"], source: "spelling" },
      { term: "Sarvam", aliases: ["Sarwam"], source: "glossary" },
    ]);
  });

  it("skips an entry it cannot understand rather than guessing at one", async () => {
    const { reader } = source([
      { id: "1", kind: "glossary", value: {} },
      { id: "2", kind: "glossary", value: null },
      { id: "3", kind: "glossary", value: "   " },
      { id: "4", kind: "glossary", value: { term: 42 } },
      { id: "5", kind: "style_preference", value: { term: "not a term" } },
      { id: "6", kind: "glossary", value: { term: "  Aksharo  " } },
    ]);

    expect(await reader.terms(WS)).toEqual([{ term: "Aksharo", source: "glossary" }]);
  });

  it("ignores a non-string alias without losing the term", async () => {
    const { reader } = source([
      { id: "1", kind: "glossary", value: { term: "Sarvam", aliases: [1, "Sarwam", null] } },
    ]);
    expect(await reader.terms(WS)).toEqual([
      { term: "Sarvam", aliases: ["Sarwam"], source: "glossary" },
    ]);
  });
});
