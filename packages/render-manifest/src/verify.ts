/**
 * The gate every cloud render passes through: parse, verify, check the clock,
 * check the caps. Four refusals, each with its own code, because "the render
 * failed" and "your plan does not allow 4K" are different conversations.
 *
 * The order is deliberate. Parsing first means the signature is computed over a
 * document whose defaults Zod has already applied, so an issuer that omitted
 * `snapCutsToFrames` and a verifier that received it explicitly still agree.
 * The clock is checked before the caps so an expired manifest never gets as far
 * as a plan message.
 */

import { RenderManifestError } from "./errors.js";
import { RenderManifestSchema, type RenderManifest } from "./schema.js";
import { verifyManifestSignature, type SignatureKey } from "./signature.js";

/**
 * Tolerance on `issuedAt` being in the future, for the usual small clock skew
 * between the API pod that issued the manifest and the render node reading it.
 * Matches the five-minute window CONTRACTS §3 gives callback signatures.
 */
export const MANIFEST_CLOCK_SKEW_MS = 5 * 60_000;

export interface VerifyRenderManifestInput {
  /** The document as it arrived: a parsed JSON value, not a string. */
  readonly manifest: unknown;
  readonly secret: string;
  readonly secretNext?: string | undefined;
  /** Defaults to `Date.now()`; a test pins it. */
  readonly now?: number;
  readonly skewMs?: number;
}

export interface VerifiedRenderManifest {
  readonly manifest: RenderManifest;
  /** Which key verified it, so a rotation can be watched in the logs. */
  readonly key: SignatureKey;
}

/**
 * Parse, verify and clock-check a manifest.
 *
 * @throws {RenderManifestError} `manifest/malformed`, `manifest/bad-signature`,
 * `manifest/expired` or `manifest/not-yet-valid`.
 */
export function verifyRenderManifest(input: VerifyRenderManifestInput): VerifiedRenderManifest {
  const parsed = RenderManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new RenderManifestError(
      "manifest/malformed",
      "the render manifest does not match the v1 schema",
      { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
    );
  }
  const manifest = parsed.data;

  const key = verifyManifestSignature({
    manifest,
    secret: input.secret,
    secretNext: input.secretNext,
  });
  if (key === null) {
    throw new RenderManifestError(
      "manifest/bad-signature",
      "the render manifest signature does not verify under any configured key",
      { manifestId: manifest.manifestId },
    );
  }

  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? MANIFEST_CLOCK_SKEW_MS;
  const expiresAt = Date.parse(manifest.expiresAt);
  if (now > expiresAt) {
    throw new RenderManifestError("manifest/expired", "the render manifest has expired", {
      manifestId: manifest.manifestId,
      expiresAt: manifest.expiresAt,
    });
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  if (issuedAt - now > skew) {
    throw new RenderManifestError(
      "manifest/not-yet-valid",
      "the render manifest was issued too far in the future for the clock skew allowance",
      { manifestId: manifest.manifestId, issuedAt: manifest.issuedAt },
    );
  }

  return { manifest, key };
}

/** One reason an output exceeded its caps, for the error detail. */
export interface CapViolation {
  readonly cap: "maxWidth" | "maxHeight" | "maxDurationMs" | "maxFps" | "allowAlpha";
  readonly requested: number | boolean;
  readonly allowed: number | boolean;
}

/**
 * Every way this manifest's `output` exceeds its own `caps`.
 *
 * `outputDurationMs` is the *rendered* length after the timemap is applied, so
 * the caller passes it in: a two-hour source cut down to forty seconds is a
 * forty-second render and must be measured as one.
 */
export function capViolations(manifest: RenderManifest, outputDurationMs: number): CapViolation[] {
  const { output, caps } = manifest;
  const violations: CapViolation[] = [];
  if (output.width > caps.maxWidth) {
    violations.push({ cap: "maxWidth", requested: output.width, allowed: caps.maxWidth });
  }
  if (output.height > caps.maxHeight) {
    violations.push({ cap: "maxHeight", requested: output.height, allowed: caps.maxHeight });
  }
  if (output.fps > caps.maxFps) {
    violations.push({ cap: "maxFps", requested: output.fps, allowed: caps.maxFps });
  }
  if (outputDurationMs > caps.maxDurationMs) {
    violations.push({
      cap: "maxDurationMs",
      requested: outputDurationMs,
      allowed: caps.maxDurationMs,
    });
  }
  if (output.kind === "alpha" && !caps.allowAlpha) {
    violations.push({ cap: "allowAlpha", requested: true, allowed: false });
  }
  return violations;
}

/**
 * Refuse a render that exceeds its entitlement.
 *
 * @throws {RenderManifestError} `manifest/caps-exceeded`, listing every breach
 * rather than the first, so one refusal tells the user everything to change.
 */
export function assertWithinCaps(manifest: RenderManifest, outputDurationMs: number): void {
  const violations = capViolations(manifest, outputDurationMs);
  if (violations.length === 0) return;
  throw new RenderManifestError(
    "manifest/caps-exceeded",
    `this render exceeds the workspace's export limits: ${violations
      .map(
        (violation) =>
          `${violation.cap} ${String(violation.requested)} > ${String(violation.allowed)}`,
      )
      .join(", ")}`,
    { manifestId: manifest.manifestId, violations },
  );
}
