import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ulid } from "ulid";

import { CONSENT_EVENTS } from "./consent-events.js";
import { MEMORY_ERRORS } from "./memory.errors.js";
import { AppException } from "../common/index.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { ConsentWithdrawnEvent } from "./consent-events.js";
import type { MemoryValue } from "./memory.dto.js";

/** 12-month rolling TTL (D62), refreshed on every write and every `touch()`. */
export const MEMORY_ENTRY_TTL_MONTHS = 12;

/** A glossary import, or a dictionary: `MAX_GLOSSARY_TERMS` in `glossary.source.ts`. */
export const MAX_MEMORY_ENTRIES_PER_KIND = 500;

/** Rows kept for the timing-nudge median (recent drags only — a trend, not a log). */
export const TIMING_NUDGE_SAMPLE_CAP = 20;

export interface MemoryEntryView {
  readonly id: string;
  readonly kind: string;
  readonly key: string;
  readonly value: string;
  readonly aliases?: readonly string[];
  readonly source: string;
  readonly deviceOnly: boolean;
  readonly hits: number;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface CreateMemoryEntryInput {
  readonly kind: string;
  readonly key: string;
  readonly value: string;
  readonly aliases?: readonly string[];
  readonly source?: string;
  readonly deviceOnly?: boolean;
}

export interface UpdateMemoryEntryInput {
  readonly value?: string;
  readonly aliases?: readonly string[];
  readonly deviceOnly?: boolean;
}

export interface ImportResult {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
}

function expiryFrom(now: Date): Date {
  const at = new Date(now);
  at.setUTCMonth(at.getUTCMonth() + MEMORY_ENTRY_TTL_MONTHS);
  return at;
}

function normaliseKey(key: string): string {
  return key.trim().normalize("NFC").toLowerCase();
}

/** Row → API view. `value` is `MemoryEntrySchema` (`memory.dto.ts`), read defensively. */
export function toView(row: {
  id: string;
  kind: string;
  value: unknown;
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
}): MemoryEntryView {
  const parsed = (row.value ?? {}) as Partial<MemoryValue>;
  return {
    id: row.id,
    kind: row.kind,
    key: typeof parsed.key === "string" ? parsed.key : "",
    value: typeof parsed.value === "string" ? parsed.value : "",
    ...(Array.isArray(parsed.aliases) ? { aliases: parsed.aliases } : {}),
    source: typeof parsed.source === "string" ? parsed.source : "manual",
    deviceOnly: parsed.deviceOnly === true,
    hits: typeof parsed.hits === "number" ? parsed.hits : 0,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `/memory` (F-204, D62) — the write side of learned memory.
 *
 * A11 already owns *reading* consent-filtered glossary terms into a
 * transcription (`transcripts/postprocess/glossary.source.ts`); this service
 * owns writing the rows that reader sees, and the CRUD/import/clear surface
 * Settings → "What Aksharo learned" is built on.
 *
 * **The gate is the same shape as `MemoryGlossarySource`'s**: every mutating
 * call re-reads the caller's current `memory` consent record rather than
 * trusting a cached flag, so a consent withdrawn a second ago is honoured on
 * the very next write.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The caller's active, un-withdrawn `memory` consent — or a 403. */
  private async requireConsent(userId: string): Promise<string> {
    const consent = await this.prisma.consentRecord.findFirst({
      where: { userId, purpose: "memory", granted: true, withdrawnAt: null },
      orderBy: { grantedAt: "desc" },
      select: { id: true },
    });
    if (consent === null) {
      throw new AppException(
        MEMORY_ERRORS.consentRequired,
        "The memory consent has not been granted.",
        HttpStatus.FORBIDDEN,
      );
    }
    return consent.id;
  }

  async list(workspaceId: string, kind?: string): Promise<readonly MemoryEntryView[]> {
    const rows = await this.prisma.memoryEntry.findMany({
      where: { workspaceId, ...(kind === undefined ? {} : { kind }) },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  /** Create, or — same `(workspaceId, kind, key)` — merge into the existing row. */
  async upsert(
    workspaceId: string,
    userId: string,
    input: CreateMemoryEntryInput,
  ): Promise<MemoryEntryView> {
    const consentId = await this.requireConsent(userId);
    const now = new Date();
    const key = normaliseKey(input.key);

    const existing = await this.findByKey(workspaceId, input.kind, key);
    if (existing !== undefined) {
      return this.applyMerge(existing, {
        value: input.value,
        aliases: input.aliases,
        deviceOnly: input.deviceOnly,
      });
    }

    const value: MemoryValue = {
      key,
      value: input.value,
      ...(input.aliases === undefined || input.aliases.length === 0
        ? {}
        : { aliases: [...input.aliases] }),
      source: input.source ?? "manual",
      deviceOnly: input.deviceOnly ?? false,
      hits: 0,
    };

    const row = await this.prisma.memoryEntry.create({
      data: {
        id: ulid(),
        workspaceId,
        userId,
        consentId,
        kind: input.kind,
        value,
        expiresAt: expiryFrom(now),
        createdAt: now,
      },
    });
    return toView(row);
  }

  async update(
    workspaceId: string,
    userId: string,
    id: string,
    input: UpdateMemoryEntryInput,
  ): Promise<MemoryEntryView> {
    await this.requireConsent(userId);
    const row = await this.prisma.memoryEntry.findFirst({ where: { id, workspaceId } });
    if (row === null) {
      throw new AppException(
        MEMORY_ERRORS.notFound,
        "Memory entry not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.applyMerge(row, input);
  }

  private async applyMerge(
    row: { id: string; value: unknown },
    patch: UpdateMemoryEntryInput,
  ): Promise<MemoryEntryView> {
    const current = (row.value ?? {}) as Partial<MemoryValue>;
    const next: MemoryValue = {
      key: typeof current.key === "string" ? current.key : "",
      value: patch.value ?? (typeof current.value === "string" ? current.value : ""),
      ...(patch.aliases !== undefined
        ? patch.aliases.length === 0
          ? {}
          : { aliases: [...patch.aliases] }
        : Array.isArray(current.aliases)
          ? { aliases: current.aliases }
          : {}),
      source: typeof current.source === "string" ? current.source : "manual",
      deviceOnly: patch.deviceOnly ?? current.deviceOnly === true,
      hits: typeof current.hits === "number" ? current.hits : 0,
    };
    const updated = await this.prisma.memoryEntry.update({
      where: { id: row.id },
      data: { value: next, expiresAt: expiryFrom(new Date()) },
    });
    return toView(updated);
  }

  async remove(workspaceId: string, userId: string, id: string): Promise<void> {
    await this.requireConsent(userId);
    const result = await this.prisma.memoryEntry.deleteMany({ where: { id, workspaceId } });
    if (result.count === 0) {
      throw new AppException(
        MEMORY_ERRORS.notFound,
        "Memory entry not found.",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /** `DELETE /memory` — clears everything for the workspace (brief §1). */
  async clearAll(workspaceId: string, userId: string): Promise<number> {
    await this.requireConsent(userId);
    const result = await this.prisma.memoryEntry.deleteMany({ where: { workspaceId } });
    return result.count;
  }

  /**
   * Consent withdrawal cascade (D62). `consentId`'s FK is `onDelete: Cascade`
   * but withdrawal only stamps `withdrawnAt` — the `consent_records` row is
   * kept for the audit trail — so the cascade never fires on its own; this is
   * the explicit erasure the brief asks for.
   */
  @OnEvent(CONSENT_EVENTS.withdrawn)
  async onConsentWithdrawn(event: ConsentWithdrawnEvent): Promise<void> {
    if (event.purpose !== "memory") return;
    const result = await this.prisma.memoryEntry.deleteMany({ where: { userId: event.userId } });
    this.logger.log(
      { userId: event.userId, deleted: result.count },
      "memory consent withdrawn: entries erased",
    );
  }

  /** CSV bulk import of glossary terms: `term` or `term,alias1;alias2` per line. */
  async importGlossary(workspaceId: string, userId: string, csv: string): Promise<ImportResult> {
    await this.requireConsent(userId);
    const lines = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== "" && line.toLowerCase() !== "term" && line.toLowerCase() !== "term,aliases",
      );

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const line of lines.slice(0, MAX_MEMORY_ENTRIES_PER_KIND)) {
      const [termRaw, aliasesRaw] = line.split(",");
      const term = termRaw?.trim() ?? "";
      if (term === "") {
        skipped += 1;
        continue;
      }
      const aliases = (aliasesRaw ?? "")
        .split(";")
        .map((alias) => alias.trim())
        .filter((alias) => alias !== "");

      const key = normaliseKey(term);
      const existing = await this.findByKey(workspaceId, "glossary", key);
      await this.upsert(workspaceId, userId, {
        kind: "glossary",
        key: term,
        value: term,
        ...(aliases.length === 0 ? {} : { aliases }),
        source: "import",
      });
      if (existing === undefined) imported += 1;
      else updated += 1;
    }

    return { imported, updated, skipped };
  }

  // ---------------------------------------------------------------------
  // Learning hooks (brief §2)
  // ---------------------------------------------------------------------

  /** A15's "Fix spelling everywhere" → a `spelling` entry, script-aware. */
  async recordSpellingFix(
    workspaceId: string,
    userId: string,
    wrong: string,
    right: string,
    script?: string,
  ): Promise<MemoryEntryView | undefined> {
    if (normaliseKey(wrong) === normaliseKey(right)) return undefined;
    return this.upsert(workspaceId, userId, {
      kind: "spelling",
      key: wrong,
      value: right,
      aliases: [wrong],
      source: script === undefined ? "autoSpellingFix" : `autoSpellingFix:${script}`,
    });
  }

  /**
   * A17 timing-nudge sink feed: one signed drag delta (ms), rolled into a
   * per-workspace median caption offset (brief §2/§3). Kept as a plain
   * service method rather than a route so a future `TimingNudgeSink`
   * implementation (A17/A02d) can call it directly once that seam lands —
   * see the final report for why the sink itself is out of scope here.
   */
  async recordTimingNudge(
    workspaceId: string,
    userId: string,
    deltaMs: number,
  ): Promise<MemoryEntryView> {
    const consentId = await this.requireConsent(userId);
    const key = "captionOffset";
    const existing = await this.findByKey(workspaceId, "timingNudge", normaliseKey(key));
    const now = new Date();

    const samples: number[] = existing
      ? readSamples(existing.value).concat(deltaMs).slice(-TIMING_NUDGE_SAMPLE_CAP)
      : [deltaMs];
    const median = medianOf(samples);

    const value: MemoryValue = {
      key,
      value: String(median),
      source: "autoTimingDrag",
      deviceOnly: false,
      hits: existing ? (readValue(existing.value).hits ?? 0) + 1 : 1,
    };
    (value as unknown as { samples: number[] }).samples = samples;

    if (existing === undefined) {
      const row = await this.prisma.memoryEntry.create({
        data: {
          id: ulid(),
          workspaceId,
          userId,
          consentId,
          kind: "timingNudge",
          value,
          expiresAt: expiryFrom(now),
          lastUsedAt: now,
          createdAt: now,
        },
      });
      return toView(row);
    }

    const row = await this.prisma.memoryEntry.update({
      where: { id: existing.id },
      data: { value, expiresAt: expiryFrom(now), lastUsedAt: now },
    });
    return toView(row);
  }

  /** Last used style/template per aspect ratio (brief §2). */
  async recordStylePreference(
    workspaceId: string,
    userId: string,
    aspect: string,
    styleId: string,
  ): Promise<MemoryEntryView> {
    return this.upsert(workspaceId, userId, {
      kind: "stylePref",
      key: aspect,
      value: styleId,
      source: "autoStyleUse",
    });
  }

  /**
   * Consent-gated glossary/spelling terms for transcription hints (brief §2,
   * `transcripts.service.ts`'s enqueue). Unlike the mutating calls this never
   * throws on a missing grant — it is read on every enqueue, and "no consent"
   * simply means "no memory hints", the same silence `MemoryGlossarySource`
   * (`transcripts/postprocess/glossary.source.ts`) answers with for reading.
   * Terms are the canonical/correct text (`value.value`), most recently
   * created first, deduplicated, unexpired only.
   */
  async glossaryTermsFor(workspaceId: string, userId: string): Promise<readonly string[]> {
    const consent = await this.prisma.consentRecord.findFirst({
      where: { userId, purpose: "memory", granted: true, withdrawnAt: null },
      orderBy: { grantedAt: "desc" },
      select: { id: true },
    });
    if (consent === null) return [];

    const rows = await this.prisma.memoryEntry.findMany({
      where: {
        workspaceId,
        kind: { in: ["glossary", "spelling"] },
        expiresAt: { gt: new Date() },
        consent: { purpose: "memory", granted: true, withdrawnAt: null },
      },
      select: { value: true },
      orderBy: { createdAt: "desc" },
      take: MAX_MEMORY_ENTRIES_PER_KIND,
    });

    const seen = new Set<string>();
    const terms: string[] = [];
    for (const row of rows) {
      const parsed = readValue(row.value);
      const term = typeof parsed.value === "string" ? parsed.value.trim() : "";
      if (term === "") continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
    }
    return terms;
  }

  /** Usage-counter refresh: `hits += 1`, `lastUsedAt = now`, TTL rolled forward. */
  async touch(id: string): Promise<void> {
    const row = await this.prisma.memoryEntry.findUnique({ where: { id } });
    if (row === null) return;
    const current = readValue(row.value);
    const now = new Date();
    await this.prisma.memoryEntry.update({
      where: { id },
      data: {
        value: { ...current, hits: (current.hits ?? 0) + 1 },
        lastUsedAt: now,
        expiresAt: expiryFrom(now),
      },
    });
  }

  private async findByKey(
    workspaceId: string,
    kind: string,
    normalisedKey: string,
  ): Promise<{ id: string; value: unknown } | undefined> {
    const rows = await this.prisma.memoryEntry.findMany({
      where: { workspaceId, kind },
      select: { id: true, value: true },
    });
    return rows.find((row) => {
      const parsed = readValue(row.value);
      return typeof parsed.key === "string" && normaliseKey(parsed.key) === normalisedKey;
    });
  }
}

function readValue(value: unknown): Partial<MemoryValue> {
  return (value ?? {}) as Partial<MemoryValue>;
}

function readSamples(value: unknown): number[] {
  const raw = (value as { samples?: unknown } | null)?.samples;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is number => typeof entry === "number")
    : [];
}

/** Median of a small sample set — order-independent, robust to one outlier drag. */
export function medianOf(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1] ?? sorted[mid] ?? 0;
  const upper = sorted[mid] ?? lower;
  return sorted.length % 2 === 0 ? Math.round((lower + upper) / 2) : upper;
}
