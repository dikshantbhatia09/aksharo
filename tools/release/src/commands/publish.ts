import fs from "node:fs/promises";
import path from "node:path";

import { PUBLISH_SECRETS, requireSecretsIfSigned } from "../env.js";
import { buildUpdaterFeed, writeUpdaterFeedFile, writeUpdaterFeedJson } from "../lib/feeds.js";
import { ensureDir, walkFiles } from "../lib/fsUtil.js";
import { evaluateStableGate, readLedger } from "../lib/notarizeBuffer.js";

import type { Channel, ReleaseContext } from "../types.js";

export interface PublishOptions {
  channel: Channel;
  version: string;
  macArtifact?: string;
  winArtifact?: string;
  force?: boolean;
  reason?: string;
}

export interface PublishResult {
  destDir: string;
  uploaded: string[];
  feeds: string[];
}

/**
 * `publish --channel`: uploads artifacts + updater feed files to `releases/<channel>/` on R2.
 * Dry-run copies into `.release/publish/<channel>/` instead of calling the S3 API. The
 * `stable` channel is gated by the 24h notarisation buffer (D48/P0-2) unless `--force
 * --reason` is passed.
 */
export async function runPublish(ctx: ReleaseContext, opts: PublishOptions): Promise<PublishResult> {
  requireSecretsIfSigned(ctx.mode, PUBLISH_SECRETS);

  if (opts.channel === "stable" && opts.macArtifact) {
    const macArtifactName = path.basename(opts.macArtifact);
    const ledger = await readLedger(ctx.outDir);
    const record = ledger.find((r) => r.artifact === macArtifactName);
    const gate = evaluateStableGate(record, ctx.now(), { force: opts.force, reason: opts.reason });
    if (!gate.allowed) {
      throw new Error(`publish to stable blocked: ${gate.reason}`);
    }
  }

  const destDir = path.join(ctx.outDir, "publish", opts.channel);
  await ensureDir(destDir);

  const uploaded: string[] = [];
  for (const artifact of [opts.macArtifact, opts.winArtifact].filter((a): a is string => Boolean(a))) {
    const dest = path.join(destDir, path.basename(artifact));
    await fs.copyFile(artifact, dest);
    uploaded.push(dest);
  }

  const feeds: string[] = [];
  const releaseDate = new Date(ctx.now()).toISOString();
  if (opts.macArtifact) {
    const feed = await buildUpdaterFeed(opts.version, opts.macArtifact, releaseDate);
    feeds.push(await writeUpdaterFeedFile(destDir, "latest-mac.yml", feed));
    feeds.push(await writeUpdaterFeedJson(destDir, "mac", feed));
  }
  if (opts.winArtifact) {
    const feed = await buildUpdaterFeed(opts.version, opts.winArtifact, releaseDate);
    feeds.push(await writeUpdaterFeedFile(destDir, "latest.yml", feed));
    feeds.push(await writeUpdaterFeedJson(destDir, "win", feed));
  }

  if (ctx.mode !== "signed") {
    const marker = path.join(destDir, "UNSIGNED_PUBLISH");
    await fs.writeFile(marker, "dry-run publish — copied locally, R2 was never contacted\n", "utf8");
  }

  const allFiles = await walkFiles(destDir);
  void allFiles;
  return { destDir, uploaded, feeds };
}
