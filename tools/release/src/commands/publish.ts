import fs from "node:fs/promises";
import path from "node:path";

import { PUBLISH_SECRETS, requireSecretsIfSigned } from "../env.js";
import { buildUpdaterFeed, writeUpdaterFeedFile, writeUpdaterFeedJson } from "../lib/feeds.js";
import { ensureDir, walkFiles } from "../lib/fsUtil.js";
import { evaluateStableGate, readLedger } from "../lib/notarizeBuffer.js";
import {
  publishedArtifactUrl,
  writePluginManifest,
  type PluginManifestInput,
} from "../lib/pluginManifest.js";

import type { Channel, ReleaseContext } from "../types.js";

export interface PublishPluginArtifact {
  /** Absolute path to the artifact (ccx / resolve zip) to copy alongside the desktop artifacts. */
  path: string;
  version: string;
  minHostVersion?: string | null;
  maxHostVersion?: string | null;
  notes?: string | null;
}

export interface PublishOptions {
  channel: Channel;
  version: string;
  macArtifact?: string;
  winArtifact?: string;
  /** C10: the `.ccx` from `package-ccx`, published under the channel manifest (brief §3). */
  ccxArtifact?: PublishPluginArtifact;
  /** C10: the Resolve bundle from `package-resolve`. */
  resolveArtifact?: PublishPluginArtifact;
  /** C10: publish-time domain for constructed download URLs (`@montaj/config`'s `BRAND.domain`
   * in production; injectable so tests never need to import the app config package). */
  domain?: string;
  force?: boolean;
  reason?: string;
}

export interface PublishResult {
  destDir: string;
  uploaded: string[];
  feeds: string[];
  pluginManifestPath?: string;
}

/**
 * `publish --channel`: uploads artifacts + updater feed files to `releases/<channel>/` on R2.
 * Dry-run copies into `.release/publish/<channel>/` instead of calling the S3 API. The
 * `stable` channel is gated by the 24h notarisation buffer (D48/P0-2) unless `--force
 * --reason` is passed.
 */
export async function runPublish(
  ctx: ReleaseContext,
  opts: PublishOptions,
): Promise<PublishResult> {
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
  for (const artifact of [opts.macArtifact, opts.winArtifact].filter((a): a is string =>
    Boolean(a),
  )) {
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await fs.writeFile(
      marker,
      "dry-run publish — copied locally, R2 was never contacted\n",
      "utf8",
    );
  }

  let pluginManifestPath: string | undefined;
  if (opts.ccxArtifact || opts.resolveArtifact || opts.macArtifact || opts.winArtifact) {
    const domain = opts.domain ?? "aksharo.ai";
    const manifest: PluginManifestInput = { channel: opts.channel, channels: {} };

    if (opts.ccxArtifact) {
      const fileName = path.basename(opts.ccxArtifact.path);
      const dest = path.join(destDir, fileName);
      await fs.copyFile(opts.ccxArtifact.path, dest);
      uploaded.push(dest);
      manifest.channels["premiere-uxp"] = {
        version: opts.ccxArtifact.version,
        minHostVersion: opts.ccxArtifact.minHostVersion ?? null,
        maxHostVersion: opts.ccxArtifact.maxHostVersion ?? null,
        downloadUrl: publishedArtifactUrl(domain, opts.channel, fileName),
        notes: opts.ccxArtifact.notes ?? null,
      };
    }

    if (opts.resolveArtifact) {
      const fileName = path.basename(opts.resolveArtifact.path);
      const dest = path.join(destDir, fileName);
      await fs.copyFile(opts.resolveArtifact.path, dest);
      uploaded.push(dest);
      manifest.channels["resolve-script"] = {
        version: opts.resolveArtifact.version,
        minHostVersion: opts.resolveArtifact.minHostVersion ?? null,
        maxHostVersion: opts.resolveArtifact.maxHostVersion ?? null,
        downloadUrl: publishedArtifactUrl(domain, opts.channel, fileName),
        notes: opts.resolveArtifact.notes ?? null,
      };
    }

    if (opts.macArtifact || opts.winArtifact) {
      manifest.desktop = {
        version: opts.version,
        notes: ctx.mode === "signed" ? null : "unsigned dry-run build",
        downloadUrl: {
          win: opts.winArtifact
            ? publishedArtifactUrl(domain, opts.channel, path.basename(opts.winArtifact))
            : null,
          mac: opts.macArtifact
            ? publishedArtifactUrl(domain, opts.channel, path.basename(opts.macArtifact))
            : null,
          linux: null,
        },
      };
    }

    pluginManifestPath = await writePluginManifest(destDir, manifest);
  }

  const allFiles = await walkFiles(destDir);
  void allFiles;
  return { destDir, uploaded, feeds, pluginManifestPath };
}
