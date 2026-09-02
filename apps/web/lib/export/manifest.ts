/**
 * Manifest handling (brief §2).
 *
 * `requestExportManifest` calls `POST /projects/{id}/exports` and, on the
 * browser path, returns the signed `RenderManifest`. `sanityCheckManifest`
 * is the client-side "verify before you draw a frame" step.
 *
 * ## Why this is not a signature check
 *
 * The brief asked for "verify signature locally (public key from config)".
 * `@montaj/render-manifest` signs with a **symmetric** HMAC-SHA256 over
 * `INTERNAL_CALLBACK_SECRET`, not an asymmetric keypair (see
 * `packages/render-manifest/README.md` and `apps/api/src/exports/README.md`'s
 * own "A reported deviation" section, which already refused an ES256/JWKS
 * endpoint for the same reason: publishing verification material for an HMAC
 * hands out the ability to forge a manifest). There is no public key to check
 * against, in this codebase or in principle — a browser cannot hold the secret
 * without exposing it to whoever reads the bundle.
 *
 * So `sanityCheckManifest` does the part of "verify" that is actually
 * available to an untrusted client: the document parses against the exact v1
 * schema the signer used (`RenderManifestSchema`), it has not expired, it is
 * not valid in the future beyond clock skew, and the requested output does not
 * exceed its own signed `caps` (`assertWithinCaps` — belt-and-braces; the
 * server already refused an over-cap render before signing). The trust
 * boundary for "this manifest really came from the API and was not tampered
 * with in flight" is TLS plus the bearer session, exactly as it is for every
 * other API response; cryptographic authenticity is re-checked server-side at
 * `POST /exports/manifests/{id}/complete`, which spends the manifest's own
 * single-use nonce.
 */

import type { ApiClient } from "@montaj/api-client";
import {
  capViolations,
  RenderManifestError,
  RenderManifestSchema,
  type CapViolation,
  type RenderManifest,
} from "@montaj/render-manifest";

import {
  exportEndpoints,
  manifestFromResponse,
  type ExportSources,
  type CreateExportRequest,
  type CreateExportResponse,
  type ManifestCompleteResponse,
} from "./endpoints";

export interface RequestManifestResult {
  readonly response: CreateExportResponse;
  /** `null` when the decision engine chose the cloud path (or a subtitle-only request). */
  readonly manifest: RenderManifest | null;
}

export async function requestExportManifest(
  client: ApiClient,
  projectId: string,
  request: CreateExportRequest,
): Promise<RequestManifestResult> {
  const response = await client.call(exportEndpoints.create, {
    params: { projectId },
    body: request,
  });
  const raw = manifestFromResponse(response);
  if (raw === null) return { response, manifest: null };
  const parsed = RenderManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderManifestError(
      "manifest/malformed",
      "the render manifest returned by the API does not match the v1 schema",
      { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
    );
  }
  return { response, manifest: parsed.data };
}

export interface ManifestSanityCheck {
  readonly ok: boolean;
  readonly expired: boolean;
  readonly notYetValid: boolean;
  readonly capViolations: readonly CapViolation[];
}

const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * The client-side sanity check described above. `outputDurationMs` is the
 * timemap's own rendered length (`buildTimeMap(...).outputDurationMs`) — pass
 * the manifest's `timemap.sourceDurationMs` when no edits are accepted yet.
 */
export function sanityCheckManifest(
  manifest: RenderManifest,
  outputDurationMs: number,
  now: number = Date.now(),
): ManifestSanityCheck {
  const expiresAt = Date.parse(manifest.expiresAt);
  const issuedAt = Date.parse(manifest.issuedAt);
  const expired = now > expiresAt;
  const notYetValid = issuedAt - now > CLOCK_SKEW_MS;
  const violations = capViolations(manifest, outputDurationMs);
  return {
    ok: !expired && !notYetValid && violations.length === 0,
    expired,
    notYetValid,
    capViolations: violations,
  };
}

export async function completeExportManifest(
  client: ApiClient,
  manifestId: string,
  result: { sizeBytes: number; durationMs: number; checksum: string },
): Promise<ManifestCompleteResponse> {
  return client.call(exportEndpoints.completeManifest, {
    params: { manifestId },
    body: result,
  });
}

/**
 * A21b: reissues `sources` once the 15-minute presigned GETs it was issued
 * with expire mid-export. Same ownership checks as completion, minus the
 * nonce claim.
 */
export async function refreshExportSources(
  client: ApiClient,
  manifestId: string,
): Promise<ExportSources> {
  return client.call(exportEndpoints.refreshSources, { params: { manifestId } });
}
