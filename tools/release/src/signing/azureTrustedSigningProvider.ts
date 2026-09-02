import { AZURE_TRUSTED_SIGNING_SECRETS, requireSecretsIfSigned } from "../env.js";
import { execCommand } from "../lib/exec.js";

import type {
  ReleaseContext,
  SignProvider,
  SignResult,
  SignTarget,
  VerifyResult,
} from "../types.js";

/**
 * Windows OV signing via Azure Trusted Signing (cloud HSM, no PFX on disk). Brief default.
 *
 * KNOWN GAP (report to orchestrator, RR-07 §P0): Azure Trusted Signing public-trust
 * certificates are issued only to entities in US/CA/EU/UK/AU/NZ/JP/KR/SG/CH/NO/IL. D69 fixes
 * the operating entity as an Indian private limited company, so this provider cannot be
 * provisioned as-is until either the entity structure changes or Microsoft opens the
 * programme to India. `WIN_SIGN_PROVIDER=digicert-key-locker` is the working alternative
 * (RR-07 P0-2 lists DigiCert among CAs offering cloud HSM / remote signing). This class still
 * exists (per brief) with real signing behind the `signed`-mode secret gate; it will fail
 * closed the same as any provider without secrets.
 */
export class AzureTrustedSigningProvider implements SignProvider {
  readonly name = "azure-trusted-signing";
  readonly requiredSecrets = AZURE_TRUSTED_SIGNING_SECRETS;

  async sign(target: SignTarget, ctx: ReleaseContext): Promise<SignResult> {
    requireSecretsIfSigned(ctx.mode, this.requiredSecrets);
    // Real invocation (never reached in dry-run; sandboxed CI never sets RELEASE_MODE=signed
    // with real secrets per the hard rule): AzureSignTool / `az trustedsigning` sign, then
    // `signtool verify /pa`.
    await execCommand("AzureSignTool", [
      "sign",
      "-kvu",
      process.env.AZURE_TRUSTED_SIGNING_ENDPOINT ?? "",
      "-kvc",
      process.env.AZURE_TRUSTED_SIGNING_CERT_PROFILE ?? "",
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
