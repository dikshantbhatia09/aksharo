import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateStableGate, readLedger, recordNotarization } from "../src/lib/notarizeBuffer.js";

import type { NotarizationRecord } from "../src/types.js";

const HOUR = 60 * 60 * 1000;

describe("24h stable-channel notarisation buffer", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "release-ledger-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("blocks publish before 24h have elapsed", () => {
    const notarizedAt = 1_000_000;
    const record: NotarizationRecord = {
      artifact: "a.zip",
      submissionId: "s1",
      notarizedAt,
      stapled: true,
    };
    const result = evaluateStableGate(record, notarizedAt + 23 * HOUR);
    expect(result.allowed).toBe(false);
    expect(result.hoursRemaining).toBeGreaterThan(0);
  });

  it("allows publish once exactly 24h have elapsed", () => {
    const notarizedAt = 1_000_000;
    const record: NotarizationRecord = {
      artifact: "a.zip",
      submissionId: "s1",
      notarizedAt,
      stapled: true,
    };
    const result = evaluateStableGate(record, notarizedAt + 24 * HOUR);
    expect(result.allowed).toBe(true);
  });

  it("blocks when the ticket was never stapled, even after 24h", () => {
    const notarizedAt = 1_000_000;
    const record: NotarizationRecord = {
      artifact: "a.zip",
      submissionId: "s1",
      notarizedAt,
      stapled: false,
    };
    const result = evaluateStableGate(record, notarizedAt + 48 * HOUR);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/stapled/);
  });

  it("blocks with no record at all", () => {
    const result = evaluateStableGate(undefined, 999_999_999);
    expect(result.allowed).toBe(false);
  });

  it("--force requires a non-empty --reason", () => {
    const notarizedAt = 1_000_000;
    const record: NotarizationRecord = {
      artifact: "a.zip",
      submissionId: "s1",
      notarizedAt,
      stapled: true,
    };
    const withoutReason = evaluateStableGate(record, notarizedAt + HOUR, {
      force: true,
      reason: "",
    });
    expect(withoutReason.allowed).toBe(false);

    const withReason = evaluateStableGate(record, notarizedAt + HOUR, {
      force: true,
      reason: "hotfix CVE-2026-1",
    });
    expect(withReason.allowed).toBe(true);
    expect(withReason.reason).toMatch(/forced/);
  });

  it("round-trips through the ledger file", async () => {
    const record: NotarizationRecord = {
      artifact: "b.zip",
      submissionId: "s2",
      notarizedAt: 42,
      stapled: true,
    };
    await recordNotarization(outDir, record);
    const ledger = await readLedger(outDir);
    expect(ledger).toEqual([record]);

    const updated: NotarizationRecord = { ...record, stapled: false };
    await recordNotarization(outDir, updated);
    const ledger2 = await readLedger(outDir);
    expect(ledger2).toEqual([updated]);
  });
});
