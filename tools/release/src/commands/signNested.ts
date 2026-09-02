import { discoverNestedBinaries, outermostBundleTarget } from "../lib/nestedBinaries.js";
import { resolveSignProvider } from "../signing/index.js";

import type { Platform, ReleaseContext } from "../types.js";

export interface SignNestedResult {
  provider: string;
  signed: { path: string; signed: boolean }[];
  verified: { path: string; verified: boolean }[];
}

/** `sign-nested`: walks an already-built app tree and signs + verifies every nested binary,
 * then the outer bundle last (RR-07: nested first, bundle last, `--deep --strict` verify). */
export async function runSignNested(
  ctx: ReleaseContext,
  appDir: string,
  bundlePath: string,
  platform: Platform,
): Promise<SignNestedResult> {
  const provider = resolveSignProvider(platform, ctx.mode);
  const nested = await discoverNestedBinaries(appDir, platform);
  const targets = [...nested, outermostBundleTarget(bundlePath, platform)];

  const signed: { path: string; signed: boolean }[] = [];
  for (const target of targets) {
    const result = await provider.sign(target, ctx);
    signed.push({ path: result.path, signed: result.signed });
  }

  const verified: { path: string; verified: boolean }[] = [];
  for (const target of targets) {
    const result = await provider.verify(target, ctx);
    verified.push({ path: result.path, verified: result.verified });
  }

  return { provider: provider.name, signed, verified };
}
