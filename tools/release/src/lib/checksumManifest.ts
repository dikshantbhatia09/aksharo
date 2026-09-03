import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, sha256File, walkFiles } from "./fsUtil.js";

export interface ChecksumEntry {
  file: string;
  sha256: string;
  bytes: number;
}

export async function buildChecksumManifest(artifactsDir: string): Promise<ChecksumEntry[]> {
  const files = (await walkFiles(artifactsDir)).filter(
    (f) => !["SIGNATURES.txt", "CHECKSUMS.sha256"].includes(path.basename(f)),
  );
  const entries: ChecksumEntry[] = [];
  for (const file of files.sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const [sha256, stat] = await Promise.all([sha256File(file), fs.stat(file)]);
    entries.push({
      file: path.relative(artifactsDir, file).split(path.sep).join("/"),
      sha256,
      bytes: stat.size,
    });
  }
  return entries;
}

export function manifestBody(entries: ChecksumEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.file}`).join("\n") + (entries.length ? "\n" : "");
}

/**
 * Writes `SIGNATURES.txt`: the SHA-256 manifest plus an HMAC signature over that manifest
 * body, using `RELEASE_CHECKSUM_SIGNING_KEY_BASE64` when set (signed mode) or a fixed
 * `dry-run` marker key otherwise. This is a release-integrity signature, unrelated to code
 * signing.
 */
export async function writeSignedChecksums(
  artifactsDir: string,
  signingKeyBase64: string | undefined,
): Promise<{ manifestPath: string; signaturePath: string }> {
  const entries = await buildChecksumManifest(artifactsDir);
  const body = manifestBody(entries);
  const manifestPath = path.join(artifactsDir, "CHECKSUMS.sha256");
  await ensureDir(artifactsDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  await fs.writeFile(manifestPath, body, "utf8");

  const key = signingKeyBase64
    ? Buffer.from(signingKeyBase64, "base64")
    : Buffer.from("dry-run-checksum-key");
  const signature = createHmac("sha256", key).update(body).digest("hex");
  const signaturePath = path.join(artifactsDir, "SIGNATURES.txt");
  const marker = signingKeyBase64
    ? ""
    : "# UNSIGNED (dry-run key) — do not trust for a real release\n";
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  await fs.writeFile(
    signaturePath,
    `${marker}hmac-sha256  ${signature}  CHECKSUMS.sha256\n`,
    "utf8",
  );

  return { manifestPath, signaturePath };
}
