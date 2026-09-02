import { APPLE_NOTARIZE_SECRETS, requireSecretsIfSigned } from "../env.js";
import { execCommand } from "../lib/exec.js";

import type { ReleaseContext, SignProvider, SignResult, SignTarget, VerifyResult } from "../types.js";

/** macOS Developer ID Application signing (codesign, hardened runtime). Used for every
 * nested Mach-O binary and the outer `.app` bundle before `notarize`. */
export class MacDeveloperIdProvider implements SignProvider {
  readonly name = "mac-developer-id";
  readonly requiredSecrets = APPLE_NOTARIZE_SECRETS;

  async sign(target: SignTarget, ctx: ReleaseContext): Promise<SignResult> {
    requireSecretsIfSigned(ctx.mode, this.requiredSecrets);
    const deep = target.kind === "app-bundle" ? ["--deep"] : [];
    await execCommand("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      ...deep,
      "--sign",
      process.env.APPLE_TEAM_ID ?? "",
      target.path,
    ]);
    return { path: target.path, signed: true, provider: this.name };
  }

  async verify(target: SignTarget, ctx: ReleaseContext): Promise<VerifyResult> {
    requireSecretsIfSigned(ctx.mode, this.requiredSecrets);
    const args = target.kind === "app-bundle" ? ["--verify", "--deep", "--strict", target.path] : ["--verify", "--strict", target.path];
    const result = await execCommand("codesign", args);
    return { path: target.path, verified: result.code === 0, detail: result.stdout || result.stderr };
  }
}
