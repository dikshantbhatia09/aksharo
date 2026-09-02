import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists, walkFiles } from "../lib/fsUtil.js";
import { evaluateStableGate, readLedger } from "../lib/notarizeBuffer.js";

import type { Channel, ReleaseContext } from "../types.js";

export interface PromoteOptions {
  from: Channel;
  to: Channel;
  artifactName?: string;
  force?: boolean;
  reason?: string;
}

export interface PromoteResult {
  copied: string[];
  gate: { allowed: boolean; reason: string };
}

/** `promote.yml` / `promote` command: copies a channel's artifacts + feed files to another
 * channel (manual promotion). Promoting to `stable` re-checks the 24h notarisation buffer. */
export async function runPromote(ctx: ReleaseContext, opts: PromoteOptions): Promise<PromoteResult> {
  let gate = { allowed: true, reason: "not stable; no gate" };
  if (opts.to === "stable") {
    const ledger = await readLedger(ctx.outDir);
    const record = opts.artifactName ? ledger.find((r) => r.artifact === opts.artifactName) : ledger[0];
    gate = evaluateStableGate(record, ctx.now(), { force: opts.force, reason: opts.reason });
    if (!gate.allowed) {
      return { copied: [], gate };
    }
  }

  const srcDir = path.join(ctx.outDir, "publish", opts.from);
  const destDir = path.join(ctx.outDir, "publish", opts.to);
  await ensureDir(destDir);

  if (!(await pathExists(srcDir))) {
    return { copied: [], gate };
  }

  const files = await walkFiles(srcDir);
  const copied: string[] = [];
  for (const file of files) {
    const rel = path.relative(srcDir, file);
    const dest = path.join(destDir, rel);
    await ensureDir(path.dirname(dest));
    await fs.copyFile(file, dest);
    copied.push(dest);
  }

  return { copied, gate };
}
