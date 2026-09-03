import fs from "node:fs/promises";
import path from "node:path";

import { buildChecksumManifest, manifestBody } from "../lib/checksumManifest.js";

import type { ReleaseContext } from "../types.js";

export interface VerifyReleaseResult {
  ok: boolean;
  mismatches: string[];
}

/** `verify-release`: re-hashes every artifact in a published channel dir and compares against
 * `CHECKSUMS.sha256`, catching corruption or a tampered upload before users see it. */
export async function runVerifyRelease(
  _ctx: ReleaseContext,
  channelDir: string,
): Promise<VerifyReleaseResult> {
  const manifestFile = path.join(channelDir, "CHECKSUMS.sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const expected = await fs.readFile(manifestFile, "utf8").catch(() => "");
  const recomputed = manifestBody(await buildChecksumManifest(channelDir));

  const expectedLines = new Set(expected.split("\n").filter(Boolean));
  const recomputedLines = recomputed.split("\n").filter(Boolean);

  const mismatches = recomputedLines.filter((line) => !expectedLines.has(line));
  return { ok: mismatches.length === 0 && expected.length > 0, mismatches };
}
