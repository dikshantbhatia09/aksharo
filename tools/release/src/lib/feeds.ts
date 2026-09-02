import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, sha256File, writeJson } from "./fsUtil.js";

/**
 * electron-updater feed files. `latest-mac.yml` (mac) and `latest.yml` (win) point at the
 * newest artifact in a channel; `publish`/`promote` write and copy these between channel
 * prefixes.
 */
export interface UpdaterFeed {
  version: string;
  files: { url: string; sha512: string; size: number }[];
  path: string;
  sha512: string;
  releaseDate: string;
}

export async function buildUpdaterFeed(
  version: string,
  artifactPath: string,
  releaseDate: string,
): Promise<UpdaterFeed> {
  const stat = await fs.stat(artifactPath);
  const sha256 = await sha256File(artifactPath); // stand-in digest; real electron-builder uses sha512 base64
  const fileName = path.basename(artifactPath);
  return {
    version,
    files: [{ url: fileName, sha512: sha256, size: stat.size }],
    path: fileName,
    sha512: sha256,
    releaseDate,
  };
}

function toYaml(feed: UpdaterFeed): string {
  const filesYaml = feed.files
    .map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}`)
    .join("\n");
  return [
    `version: ${feed.version}`,
    "files:",
    filesYaml,
    `path: ${feed.path}`,
    `sha512: ${feed.sha512}`,
    `releaseDate: '${feed.releaseDate}'`,
    "",
  ].join("\n");
}

export async function writeUpdaterFeedFile(outDir: string, fileName: "latest-mac.yml" | "latest.yml", feed: UpdaterFeed): Promise<string> {
  await ensureDir(outDir);
  const file = path.join(outDir, fileName);
  await fs.writeFile(file, toYaml(feed), "utf8");
  return file;
}

/** Also write the feed as JSON alongside the YAML for tests/tools that prefer structured data. */
export async function writeUpdaterFeedJson(outDir: string, artifactName: string, feed: UpdaterFeed): Promise<string> {
  const file = path.join(outDir, `${artifactName}.feed.json`);
  await writeJson(file, feed);
  return file;
}
