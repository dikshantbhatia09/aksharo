import { DIGICERT_KEY_LOCKER_SECRETS, requireSecretsIfSigned } from "../env.js";
import { execCommand } from "../lib/exec.js";

import type {
  ReleaseContext,
  SignProvider,
  SignResult,
  SignTarget,
  VerifyResult,
} from "../types.js";

/**
 * Windows OV signing via DigiCert KeyLocker (cloud HSM, `smctl`/`signtool` with the KeyLocker
 * KSP; no PFX file). Selected with `WIN_SIGN_PROVIDER=digicert-key-locker` — the practical
 * default given `AzureTrustedSigningProvider`'s India-entity gap (see that file's docblock).
 */
export class DigiCertKeyLockerProvider implements SignProvider {
  readonly name = "digicert-key-locker";
  readonly requiredSecrets = DIGICERT_KEY_LOCKER_SECRETS;

  async sign(target: SignTarget, ctx: ReleaseContext): Promise<SignResult> {
    requireSecretsIfSigned(ctx.mode, this.requiredSecrets);
    await execCommand("smctl", [
      "sign",
      "--keypair-alias",
      process.env.DIGICERT_KEYLOCKER_KEYPAIR_ALIAS ?? "",
      "--input",
      target.path,
    ]);
    return { path: target.path, signed: true, provider: this.name };
  }

  async verify(target: SignTarget, ctx: ReleaseContext): Promise<VerifyResult> {
    requireSecretsIfSigned(ctx.mode, this.requiredSecrets);
    const result = await execCommand("signtool", ["verify", "/pa", target.path]);
    return {
      path: target.path,
      verified: result.code === 0,
      detail: result.stdout || result.stderr,
    };
  }
}
