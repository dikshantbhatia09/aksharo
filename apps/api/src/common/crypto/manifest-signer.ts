import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";
import {
  type RenderManifest,
  RenderManifestError,
  type UnsignedRenderManifest,
  verifyRenderManifest,
  withSignature,
} from "@montaj/render-manifest";

import { ENV } from "../../config/config.module.js";

/**
 * The one place `INTERNAL_CALLBACK_SECRET` meets a render manifest (THREAT-MODEL
 * T10).
 *
 * `@montaj/render-manifest` is pure — it takes a secret as an argument rather
 * than reading `process.env` — so this is the thin, injectable seam that reads
 * `Env` once and hands every caller in `exports/**` a signer that already knows
 * which keys are configured. Nothing outside this file touches
 * `INTERNAL_CALLBACK_SECRET` for manifest purposes.
 *
 * `INTERNAL_CALLBACK_SECRET_NEXT` is accepted for verification only — an issuer
 * always signs with the primary, exactly as CONTRACTS §3 says worker callbacks
 * do — so one rotation procedure covers both directions.
 */
@Injectable()
export class ManifestSignerService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Signs an unsigned manifest with the primary secret. */
  sign(manifest: UnsignedRenderManifest): RenderManifest {
    return withSignature(manifest, this.env.INTERNAL_CALLBACK_SECRET);
  }

  /**
   * Parses, verifies and clock-checks a manifest against the primary and (when
   * configured) the rotation key.
   *
   * @throws RenderManifestError `manifest/malformed`, `manifest/bad-signature`,
   * `manifest/expired` or `manifest/not-yet-valid`.
   */
  verify(manifest: unknown, now?: number): RenderManifest {
    const result = verifyRenderManifest({
      manifest,
      secret: this.env.INTERNAL_CALLBACK_SECRET,
      secretNext: this.env.INTERNAL_CALLBACK_SECRET_NEXT,
      ...(now === undefined ? {} : { now }),
    });
    return result.manifest;
  }
}

export { RenderManifestError };
