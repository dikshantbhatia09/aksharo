import path from "node:path";

import { readJson, writeJson } from "./fsUtil.js";

import type { NotarizationRecord } from "../types.js";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function ledgerPath(outDir: string): string {
  return path.join(outDir, "notarization-ledger.json");
}

export async function readLedger(outDir: string): Promise<NotarizationRecord[]> {
  return readJson<NotarizationRecord[]>(ledgerPath(outDir), []);
}

export async function recordNotarization(
  outDir: string,
  record: NotarizationRecord,
): Promise<void> {
  const ledger = await readLedger(outDir);
  const next = [...ledger.filter((r) => r.artifact !== record.artifact), record];
  await writeJson(ledgerPath(outDir), next);
}

export interface StableGateResult {
  allowed: boolean;
  reason: string;
  hoursRemaining?: number;
}

/**
 * RR-07 "assume 24 h worst case; never launch inside that window" (D48/P0-2). An artifact
 * may publish to the `stable` channel only once `now >= notarizedAt + 24h`, unless the
 * caller passes `force: true` with a non-empty `reason` (audited into the ledger entry via
 * the caller).
 */
export function evaluateStableGate(
  record: NotarizationRecord | undefined,
  now: number,
  opts: { force?: boolean; reason?: string } = {},
): StableGateResult {
  if (!record) {
    return { allowed: false, reason: "no notarization record found for this artifact" };
  }
  if (!record.stapled) {
    return { allowed: false, reason: "notarization ticket not stapled" };
  }
  const readyAt = record.notarizedAt + TWENTY_FOUR_HOURS_MS;
  if (now >= readyAt) {
    return { allowed: true, reason: "24h buffer elapsed" };
  }
  if (opts.force) {
    if (!opts.reason || opts.reason.trim() === "") {
      return { allowed: false, reason: "--force requires a non-empty --reason" };
    }
    return { allowed: true, reason: `forced: ${opts.reason}` };
  }
  const hoursRemaining = Math.ceil((readyAt - now) / (60 * 60 * 1000));
  return {
    allowed: false,
    reason: `24h notarisation buffer not elapsed (${hoursRemaining}h remaining); use --force --reason "..." to override`,
    hoursRemaining,
  };
}
