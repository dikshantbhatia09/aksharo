import fs from "node:fs/promises";
import path from "node:path";

import type {
  ReleaseContext,
  SignProvider,
  SignResult,
  SignTarget,
  VerifyResult,
} from "../types.js";

/**
 * Default provider (hard rule: DRY-RUN ONLY, never sign anything for real). Instead of
 * invoking `codesign`/`signtool`, it writes a sibling `<name>.UNSIGNED` marker file next to
 * the target recording which provider *would* have signed it, and "verifies" by checking
 * that marker exists. This lets `sign-nested`, `notarize`, `sign-zxp` exercise their full
 * discovery/ordering/reporting logic in CI without any credentials or network calls.
 */
export class DryRunSignProvider implements SignProvider {
  readonly name = "dry-run";
  readonly requiredSecrets: readonly string[] = [];

  async sign(target: SignTarget, _ctx: ReleaseContext): Promise<SignResult> {
    const marker = `${target.path}.UNSIGNED`;
    await fs.writeFile(
      marker,
      `UNSIGNED (dry-run)\ntarget: ${path.basename(target.path)}\nkind: ${target.kind}\nplatform: ${target.platform}\n`,
      "utf8",
    );
    return { path: target.path, signed: false, provider: this.name, marker };
  }

  async verify(target: SignTarget, _ctx: ReleaseContext): Promise<VerifyResult> {
    const marker = `${target.path}.UNSIGNED`;
    try {
      await fs.access(marker);
      return { path: target.path, verified: true, detail: `dry-run marker present at ${marker}` };
    } catch {
      return { path: target.path, verified: false, detail: `dry-run marker missing: ${marker}` };
    }
  }
}
