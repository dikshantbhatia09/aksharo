import { createHash } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { BREACHED_PASSWORD_FLAG } from "./auth.constants.js";
import { ENV } from "../config/config.module.js";

/** Have I Been Pwned's k-anonymity range endpoint (RFC-style padded responses). */
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range";

/** A sign-up must not wait on someone else's service. */
const REQUEST_TIMEOUT_MS = 2_000;

export interface BreachLookup {
  /** `undefined` when the check did not run (flag off) or could not run. */
  readonly breached: boolean | undefined;
  readonly count: number;
  readonly checked: boolean;
}

/**
 * Breached-password check (THREAT-MODEL T1) over HIBP's k-anonymity range API.
 *
 * Only the first five hex characters of `sha1(password)` leave the process; the
 * service returns every suffix under that prefix and the comparison happens here,
 * so the password itself is never transmitted, hashed or otherwise. `Add-Padding`
 * asks HIBP to pad the response so its length does not leak the prefix's
 * popularity.
 *
 * **Feature-flagged and fail-open** (brief §1): a timeout, a 500 or a DNS failure
 * must never stop a legitimate sign-up. When the check cannot run the password is
 * accepted and the event is logged.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * `FEATURE_FLAGS_JSON` → `{"auth.breachedPasswordCheck": false}` to turn it OFF.
   *
   * On by default since the launch-readiness audit (P0-06). It used to default
   * off, so the compromised-password screening NIST SP 800-63B-4 requires was
   * absent everywhere it had not been thought about — including the live
   * environment, whose `FEATURE_FLAGS_JSON` is `{}`. A control that has to be
   * remembered is a control that is missing. The opt-out stays for an air-gapped
   * deployment that cannot reach HIBP at all, where every lookup would otherwise
   * spend its 2 s timeout before failing open.
   */
  get enabled(): boolean {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    return this.env.FEATURE_FLAGS_JSON[BREACHED_PASSWORD_FLAG] !== false;
  }

  async check(password: string): Promise<BreachLookup> {
    if (!this.enabled) return { breached: undefined, count: 0, checked: false };

    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    try {
      const response = await fetch(`${HIBP_RANGE_URL}/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "aksharo-api" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status }, "breach check unavailable; allowing");
        return { breached: undefined, count: 0, checked: false };
      }
      const count = countFor(await response.text(), suffix);
      return { breached: count > 0, count, checked: true };
    } catch (error) {
      this.logger.warn({ err: error }, "breach check failed; allowing");
      return { breached: undefined, count: 0, checked: false };
    }
  }
}

/**
 * Find `suffix` in a `SUFFIX:COUNT` range response.
 *
 * Padded responses contain entries with a count of `0`, which must be treated as
 * absent — that is the whole point of the padding.
 */
export function countFor(body: string, suffix: string): number {
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue;
    const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
    return Number.isFinite(count) ? count : 0;
  }
  return 0;
}
