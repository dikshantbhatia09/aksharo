/** Shared types for the release CLI. */

export type Platform = "mac" | "win";
export type Channel = "alpha" | "beta" | "stable";
export type ReleaseMode = "dry-run" | "signed";

export interface ReleaseContext {
  /** Repo root, resolved from this file's location. */
  repoRoot: string;
  /** Output directory for all generated artifacts (default `<repoRoot>/.release`). */
  outDir: string;
  mode: ReleaseMode;
  /** Injectable for tests; defaults to `Date.now`. */
  now: () => number;
}

export interface SignTarget {
  /** Absolute path to the binary/executable to sign. */
  path: string;
  platform: Platform;
  kind: "app-bundle" | "mach-o" | "pe-exe" | "pe-dll";
}

export interface SignResult {
  path: string;
  signed: boolean;
  provider: string;
  /** Path to an `UNSIGNED` marker file written next to the target in dry-run mode. */
  marker?: string;
}

export interface VerifyResult {
  path: string;
  verified: boolean;
  detail: string;
}

/** `SignProvider` is the seam between the CLI and a real cloud-HSM signer (CONTRACTS-adjacent; not frozen). */
export interface SignProvider {
  readonly name: string;
  /** Env var names this provider requires when `mode === "signed"`. */
  readonly requiredSecrets: readonly string[];
  sign(target: SignTarget, ctx: ReleaseContext): Promise<SignResult>;
  verify(target: SignTarget, ctx: ReleaseContext): Promise<VerifyResult>;
}

export interface NotarizationRecord {
  artifact: string;
  submissionId: string;
  notarizedAt: number;
  stapled: boolean;
}

export class ReleaseFailClosedError extends Error {
  constructor(
    message: string,
    public readonly missing: readonly string[],
  ) {
    super(message);
    this.name = "ReleaseFailClosedError";
  }
}
