import { describe, expect, it, vi } from "vitest";

import { MEMORY_ERRORS } from "./memory.errors.js";
import { medianOf, MemoryService } from "./memory.service.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER00000000000000000A";
const CONSENT = "01JCCONSENT000000000000000";

interface Row {
  id: string;
  workspaceId: string;
  userId: string | null;
  consentId: string;
  kind: string;
  value: unknown;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function harness(options: { consented?: boolean } = {}): {
  service: MemoryService;
  rows: Row[];
  prisma: PrismaService;
} {
  const rows: Row[] = [];
  const consented = options.consented ?? true;

  const prisma = {
    consentRecord: {
      findFirst: vi.fn(async () => (consented ? { id: CONSENT } : null)),
    },
    memoryEntry: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter(
          (row) =>
            row.workspaceId === where["workspaceId"] &&
            (where["kind"] === undefined || row.kind === where["kind"]),
        ),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => row.id === where["id"] && row.workspaceId === where["workspaceId"]) ??
        null,
      ),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => row.id === where["id"]) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        rows.push(data);
        return data;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (row === undefined) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        const keep = rows.filter((row) => {
          if (where["id"] !== undefined && row.id !== where["id"]) return true;
          if (where["workspaceId"] !== undefined && row.workspaceId !== where["workspaceId"]) {
            return true;
          }
          if (where["userId"] !== undefined && row.userId !== where["userId"]) return true;
          return false;
        });
        rows.length = 0;
        rows.push(...keep);
        return { count: before - rows.length };
      }),
    },
  } as unknown as PrismaService;

  return { service: new MemoryService(prisma), rows, prisma };
}

describe("MemoryService consent gating (acceptance #1)", () => {
  it("refuses to create an entry without an active memory consent", async () => {
    const { service } = harness({ consented: false });
    await expect(
      service.upsert(WS, USER, { kind: "glossary", key: "aksharo", value: "Aksharo" }),
    ).rejects.toMatchObject({ code: MEMORY_ERRORS.consentRequired, httpStatus: 403 });
  });

  it("refuses import, update, delete and clear without consent", async () => {
    const { service } = harness({ consented: false });
    await expect(service.importGlossary(WS, USER, "Aksharo")).rejects.toMatchObject({
      code: MEMORY_ERRORS.consentRequired,
    });
    await expect(service.update(WS, USER, "x", { value: "y" })).rejects.toMatchObject({
      code: MEMORY_ERRORS.consentRequired,
    });
    await expect(service.remove(WS, USER, "x")).rejects.toMatchObject({
      code: MEMORY_ERRORS.consentRequired,
    });
    await expect(service.clearAll(WS, USER)).rejects.toMatchObject({
      code: MEMORY_ERRORS.consentRequired,
    });
  });

  it("stores nothing when the consent check throws", async () => {
    const { service, rows } = harness({ consented: false });
    await expect(
      service.upsert(WS, USER, { kind: "spelling", key: "achsharo", value: "Aksharo" }),
    ).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });
});

describe("MemoryService CRUD", () => {
  it("creates an entry with a 12-month rolling expiry and the caller's consent id", async () => {
    const { service, rows } = harness();
    const entry = await service.upsert(WS, USER, {
      kind: "glossary",
      key: "Aksharo",
      value: "Aksharo",
      aliases: ["Akshara", "Akshero"],
    });
    expect(entry.key).toBe("aksharo");
    expect(entry.aliases).toEqual(["Akshara", "Akshero"]);
    expect(rows[0]?.consentId).toBe(CONSENT);

    const expiresAt = new Date(entry.expiresAt);
    const createdAt = new Date(entry.createdAt);
    const months =
      (expiresAt.getUTCFullYear() - createdAt.getUTCFullYear()) * 12 +
      (expiresAt.getUTCMonth() - createdAt.getUTCMonth());
    expect(months).toBe(12);
  });

  it("merges into the existing row for the same (workspace, kind, key) instead of duplicating", async () => {
    const { service, rows } = harness();
    await service.upsert(WS, USER, { kind: "glossary", key: "Aksharo", value: "Aksharo" });
    const merged = await service.upsert(WS, USER, {
      kind: "glossary",
      key: "aksharo",
      value: "Aksharo",
      aliases: ["Akshara"],
    });
    expect(rows).toHaveLength(1);
    expect(merged.aliases).toEqual(["Akshara"]);
  });

  it("refreshes expiresAt on update (rolling TTL) and rejects an unknown id", async () => {
    const { service } = harness();
    const created = await service.upsert(WS, USER, {
      kind: "spelling",
      key: "achsharo",
      value: "Aksharo",
    });
    const before = created.expiresAt;
    const updated = await service.update(WS, USER, created.id, { value: "Aksharo Studio" });
    expect(updated.value).toBe("Aksharo Studio");
    expect(new Date(updated.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());

    await expect(service.update(WS, USER, "missing-id", { value: "x" })).rejects.toMatchObject({
      code: MEMORY_ERRORS.notFound,
    });
  });

  it("deletes one entry and clears all entries for the workspace", async () => {
    const { service, rows } = harness();
    const a = await service.upsert(WS, USER, { kind: "glossary", key: "a", value: "A" });
    await service.upsert(WS, USER, { kind: "glossary", key: "b", value: "B" });
    await service.remove(WS, USER, a.id);
    expect(rows).toHaveLength(1);

    const cleared = await service.clearAll(WS, USER);
    expect(cleared).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it("scopes list and remove to the caller's workspace", async () => {
    const { service, rows } = harness();
    await service.upsert(WS, USER, { kind: "glossary", key: "a", value: "A" });
    const other = "01JCOTHERWS0000000000000A";
    expect(await service.list(other)).toEqual([]);
    await expect(service.remove(other, USER, rows[0]!.id)).rejects.toMatchObject({
      code: MEMORY_ERRORS.notFound,
    });
  });
});

describe("MemoryService glossary import", () => {
  it("imports terms and aliases from CSV, skipping blank lines and the header", async () => {
    const { service } = harness();
    const result = await service.importGlossary(
      WS,
      USER,
      "term,aliases\nAksharo,Akshara;Akshero\n\nSarvam\n",
    );
    expect(result).toEqual({ imported: 2, updated: 0, skipped: 0 });

    const entries = await service.list(WS, "glossary");
    expect(entries.map((entry) => entry.value).sort()).toEqual(["Aksharo", "Sarvam"]);
    expect(entries.find((entry) => entry.value === "Aksharo")?.aliases).toEqual([
      "Akshara",
      "Akshero",
    ]);
  });

  it("re-importing the same term updates rather than duplicates", async () => {
    const { service } = harness();
    await service.importGlossary(WS, USER, "Aksharo");
    const second = await service.importGlossary(WS, USER, "Aksharo,Akshero");
    expect(second).toEqual({ imported: 0, updated: 1, skipped: 0 });
    expect(await service.list(WS, "glossary")).toHaveLength(1);
  });
});

describe("MemoryService learning hooks", () => {
  it("records a spelling fix as wrong-spelling alias -> correct value", async () => {
    const { service } = harness();
    const entry = await service.recordSpellingFix(WS, USER, "achsharo", "Aksharo", "latn");
    expect(entry).toMatchObject({
      kind: "spelling",
      key: "achsharo",
      value: "Aksharo",
      aliases: ["achsharo"],
      source: "autoSpellingFix:latn",
    });
  });

  it("does nothing when the 'fix' does not actually change the spelling", async () => {
    const { service, rows } = harness();
    const result = await service.recordSpellingFix(WS, USER, "Aksharo", "aksharo");
    expect(result).toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it("rolls consecutive drag deltas into a per-workspace median caption offset", async () => {
    const { service } = harness();
    await service.recordTimingNudge(WS, USER, 100);
    await service.recordTimingNudge(WS, USER, 120);
    const third = await service.recordTimingNudge(WS, USER, 140);
    expect(third.kind).toBe("timingNudge");
    expect(third.value).toBe("120");
    expect(third.hits).toBe(3);

    const list = await service.list(WS, "timingNudge");
    expect(list).toHaveLength(1);
  });

  it("records the last style used per aspect, one entry per aspect", async () => {
    const { service } = harness();
    await service.recordStylePreference(WS, USER, "9:16", "style-bold");
    const updated = await service.recordStylePreference(WS, USER, "9:16", "style-neon");
    expect(updated.value).toBe("style-neon");
    expect(await service.list(WS, "stylePref")).toHaveLength(1);
  });
});

describe("MemoryService consent withdrawal cascade (D62)", () => {
  it("erases every entry for the user when the memory consent is withdrawn", async () => {
    const { service, rows } = harness();
    await service.upsert(WS, USER, { kind: "glossary", key: "a", value: "A" });
    await service.upsert(WS, USER, { kind: "spelling", key: "b", value: "B" });
    expect(rows).toHaveLength(2);

    await service.onConsentWithdrawn({ userId: USER, workspaceId: WS, purpose: "memory" });
    expect(rows).toHaveLength(0);
  });

  it("ignores a withdrawal of an unrelated purpose", async () => {
    const { service, rows } = harness();
    await service.upsert(WS, USER, { kind: "glossary", key: "a", value: "A" });
    await service.onConsentWithdrawn({ userId: USER, workspaceId: WS, purpose: "analytics" });
    expect(rows).toHaveLength(1);
  });
});

describe("medianOf", () => {
  it("is order-independent and robust to a single outlier drag", () => {
    expect(medianOf([100, 120, 140])).toBe(120);
    expect(medianOf([140, 100, 120])).toBe(120);
    expect(medianOf([100, 120, 5000])).toBe(120);
    expect(medianOf([])).toBe(0);
  });

  it("averages the two middle samples for an even-sized set", () => {
    expect(medianOf([100, 120, 140, 160])).toBe(130);
  });
});
