import path from "node:path";

import { writeSignedChecksums } from "../lib/checksumManifest.js";

import type { ReleaseContext } from "../types.js";

export interface ChecksumsResult {
  manifestPath: string;
  signaturePath: string;
}

/** `checksums`: SHA-256 manifest of every artifact plus an HMAC "signature" file
 * (`SIGNATURES.txt`). Signing key comes from `RELEASE_CHECKSUM_SIGNING_KEY_BASE64` in signed
 * mode; dry-run uses a fixed local key and marks the file `UNSIGNED`. */
export async function runChecksums(ctx: ReleaseContext, channel: string): Promise<ChecksumsResult> {
  const artifactsDir = path.join(ctx.outDir, "artifacts");
  const key = ctx.mode === "signed" ? process.env.RELEASE_CHECKSUM_SIGNING_KEY_BASE64 : undefined;
  const { manifestPath, signaturePath } = await writeSignedChecksums(artifactsDir, key);
  void channel;
  return { manifestPath, signaturePath };
}
