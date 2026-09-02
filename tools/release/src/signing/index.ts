import { winSignProviderName } from "../env.js";
import { AzureTrustedSigningProvider } from "./azureTrustedSigningProvider.js";
import { DigiCertKeyLockerProvider } from "./digicertKeyLockerProvider.js";
import { DryRunSignProvider } from "./dryRunProvider.js";
import { MacDeveloperIdProvider } from "./macDeveloperIdProvider.js";

import type { Platform, SignProvider } from "../types.js";

export { DryRunSignProvider } from "./dryRunProvider.js";
export { AzureTrustedSigningProvider } from "./azureTrustedSigningProvider.js";
export { DigiCertKeyLockerProvider } from "./digicertKeyLockerProvider.js";
export { MacDeveloperIdProvider } from "./macDeveloperIdProvider.js";

/**
 * Resolves the signing provider for a platform/mode. Dry-run always uses `DryRunSignProvider`
 * regardless of `WIN_SIGN_PROVIDER` so local/CI runs never need any signing secret.
 */
export function resolveSignProvider(platform: Platform, mode: "dry-run" | "signed"): SignProvider {
  if (mode === "dry-run") return new DryRunSignProvider();
  if (platform === "mac") return new MacDeveloperIdProvider();
  return winSignProviderName() === "digicert-key-locker"
    ? new DigiCertKeyLockerProvider()
    : new AzureTrustedSigningProvider();
}
