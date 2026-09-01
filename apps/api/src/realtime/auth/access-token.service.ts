import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { AccessTokenError, verifyAccessToken } from "./access-token.js";
import { ENV } from "../../config/config.module.js";

import type { AccessTokenClaims } from "./access-token.js";

/**
 * Verifies access tokens against `JWT_PUBLIC_KEY`.
 *
 * **Interim**, exactly as `access-token.ts` says: A04 owns authentication and this
 * provider disappears when its guard lands. It exists so the realtime gateway and
 * the public job endpoints can refuse an anonymous caller *today*, and so both do
 * it the same way.
 */
@Injectable()
export class AccessTokenService {
  private readonly logger = new Logger(AccessTokenService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** @throws AccessTokenError */
  verify(token: string): AccessTokenClaims {
    return verifyAccessToken(token, { publicKeyPem: this.env.JWT_PUBLIC_KEY });
  }

  /** Non-throwing variant; logs the reason and returns `undefined`. */
  tryVerify(token: string): AccessTokenClaims | undefined {
    try {
      return this.verify(token);
    } catch (error) {
      const reason = error instanceof AccessTokenError ? error.reason : "unknown";
      // The reason is logged, never returned: telling an anonymous caller which
      // half of the check failed is an oracle.
      this.logger.debug({ reason }, "access token rejected");
      return undefined;
    }
  }
}
