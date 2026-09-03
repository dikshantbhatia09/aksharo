import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";

import type { Env } from "@montaj/config";

import {
  ATTEMPT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyInternalSignature,
} from "./internal-signature.js";
import { AppException } from "../common/errors/error-codes.js";
import { ENV } from "../config/config.module.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";

import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";

/** A verified internal request carries the attempt id the signature covered. */
export interface SignedInternalRequest extends RawBodyRequest<Request> {
  attemptId?: string;
}

/**
 * Guards `/internal/**`: only a caller holding `INTERNAL_CALLBACK_SECRET` gets in
 * (THREAT-MODEL T8).
 *
 * Every failure is the same 401 with the same message. The specific
 * {@link SignatureFailure} is logged and never returned, because "your timestamp
 * is stale" and "your signature is wrong" together tell an attacker which half to
 * work on.
 *
 * The guard needs `request.rawBody`, which exists because `main.ts` creates the
 * application with `{ rawBody: true }`. Without it every call fails closed with
 * `missing_body` rather than silently verifying a re-encoded body.
 *
 * Both `INTERNAL_CALLBACK_SECRET` and, while a rotation is in progress,
 * `INTERNAL_CALLBACK_SECRET_NEXT` are accepted; a callback verified by the second
 * one is logged so an operator can see when the roll is finished.
 */
@Injectable()
export class InternalSignatureGuard implements CanActivate {
  private readonly logger = new Logger(InternalSignatureGuard.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SignedInternalRequest>();

    const result = verifyInternalSignature({
      secret: this.env.INTERNAL_CALLBACK_SECRET,
      secretNext: this.env.INTERNAL_CALLBACK_SECRET_NEXT,
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      attempt: request.headers[ATTEMPT_HEADER],
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      timestamp: request.headers[TIMESTAMP_HEADER],
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      signature: request.headers[SIGNATURE_HEADER],
      body: request.rawBody,
    });

    if (!result.ok) {
      this.logger.warn(
        { failure: result.failure, path: request.path },
        "internal callback rejected",
      );
      throw new AppException(
        result.failure === "timestamp_skew"
          ? JOB_ERROR_CODES.timestampSkew
          : JOB_ERROR_CODES.signatureInvalid,
        "The request signature could not be verified.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (result.key === "next") {
      // Visible proof that a rotation is still in flight: this worker has not
      // been rolled onto the promoted secret yet.
      this.logger.log({ path: request.path }, "internal callback verified with the NEXT secret");
    }

    request.attemptId = result.attemptId;
    return true;
  }
}
