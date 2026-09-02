/**
 * Every refusal the manifest path can produce, as one error with a stable code.
 *
 * A render worker turns these straight into the `error.code` of its completion
 * callback (CONTRACTS §3), so the code is a wire value: renaming one changes
 * what an operator greps for in the dead-letter table.
 */

export type RenderManifestErrorCode =
  /** The document did not parse against {@link RenderManifestSchema}. */
  | "manifest/malformed"
  /** The HMAC did not match under any configured key. */
  | "manifest/bad-signature"
  /** `expiresAt` is in the past. */
  | "manifest/expired"
  /** `issuedAt` is far enough in the future that a clock is wrong. */
  | "manifest/not-yet-valid"
  /** The manifest asks for more than its own `caps` allow. */
  | "manifest/caps-exceeded"
  /** No signing secret was configured, so nothing could be verified. */
  | "manifest/no-secret";

export class RenderManifestError extends Error {
  public override readonly name = "RenderManifestError";

  constructor(
    readonly code: RenderManifestErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Narrowing guard, optionally on one code. */
export function isRenderManifestError(
  error: unknown,
  code?: RenderManifestErrorCode,
): error is RenderManifestError {
  return error instanceof RenderManifestError && (code === undefined || error.code === code);
}
