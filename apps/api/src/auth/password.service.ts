import { randomBytes } from "node:crypto";

import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import {
  hash as argon2Hash,
  hashSync as argon2HashSync,
  parseOptions,
  verify as argon2Verify,
} from "@node-rs/argon2";

import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  AUTH_ERRORS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "./auth.constants.js";
import { commonPasswordReason } from "./common-passwords.js";
import { AppException } from "../common/index.js";

/**
 * `Algorithm.Argon2id`. Written as the literal rather than imported, because
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which
 * `isolatedModules` (tsconfig base) forbids importing.
 */
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: ARGON2_MEMORY_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

/**
 * A dummy hash with the production parameters, verified against when the account
 * does not exist so that "unknown email" and "wrong password" take the same time
 * (THREAT-MODEL T1: an enumerable login is a shortlist for credential stuffing).
 */
let absentUserHash: string | undefined;

function absentHash(): string {
  // Computed once, from a value nobody knows, so it is not a shipped credential
  // (THREAT-MODEL T21) and costs exactly what a real verification costs.
  absentUserHash ??= argon2HashSync(randomBytes(32).toString("hex"), ARGON2_OPTIONS);
  return absentUserHash;
}

/** Reasons a password is refused; the client shows them, so they are specific. */
export type PasswordRejection =
  | "too_short"
  | "too_long"
  | "contains_email"
  | "breached"
  | "common_password"
  | "repeated_characters"
  | "sequential_characters"
  | "contains_product_name";

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /** argon2id, 64 MiB / 3 iterations / 1 lane (brief §1). */
  async hash(password: string): Promise<string> {
    return argon2Hash(password, ARGON2_OPTIONS);
  }

  /**
   * Constant-ish time credential check.
   *
   * `storedHash === null` (an account that only ever used OAuth, or no account at
   * all) still runs a full argon2 verification against {@link absentHash},
   * so the response time does not reveal which case it was.
   */
  async verify(storedHash: string | null, password: string): Promise<boolean> {
    try {
      const matched = await argon2Verify(storedHash ?? absentHash(), password);
      return storedHash === null ? false : matched;
    } catch (error) {
      // A malformed or truncated hash in the database is an integrity problem, not
      // a valid login: log it and deny.
      this.logger.warn({ err: error }, "password hash could not be verified");
      return false;
    }
  }

  /**
   * `true` when a stored hash was produced with weaker parameters than the current
   * policy, so the caller should rehash on the next successful login.
   */
  needsRehash(storedHash: string): boolean {
    try {
      const options = parseOptions(storedHash);
      return (
        options.algorithm !== ARGON2ID ||
        options.memoryCost < ARGON2_MEMORY_KIB ||
        options.timeCost < ARGON2_TIME_COST ||
        options.parallelism !== ARGON2_PARALLELISM
      );
    } catch {
      return true;
    }
  }

  /**
   * Local password policy (NIST SP 800-63B-4: length and a blocklist, never
   * composition rules).
   *
   * The remote breach check stays separate because it is a network call that is
   * feature-flagged and fails open; {@link commonPasswordReason} is the bounded,
   * in-process floor under it, so the blocklist requirement holds even when HIBP
   * is unreachable (launch-readiness P0-06).
   */
  check(password: string, email: string): PasswordRejection | undefined {
    if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
    if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 3 && password.toLowerCase().includes(local)) return "contains_email";
    return commonPasswordReason(password);
  }

  /** {@link check}, as an exception. */
  assertAcceptable(password: string, email: string): void {
    const rejection = this.check(password, email);
    if (rejection === undefined) return;
    throw new AppException(
      AUTH_ERRORS.weakPassword,
      // eslint-disable-next-line security/detect-object-injection -- rejection is typed enum PasswordRejectionReason
      PASSWORD_REJECTION_MESSAGES[rejection],
      HttpStatus.BAD_REQUEST,
      { reason: rejection, minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
    );
  }
}

/**
 * What the user is told.
 *
 * Every message says what to change and nothing about how the decision was
 * reached: "this is on a list of the 100 most common passwords" is a hint worth
 * having on the other side of the login form.
 */
const PASSWORD_REJECTION_MESSAGES: Readonly<Record<PasswordRejection, string>> = {
  too_short: `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`,
  too_long: `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
  contains_email: "Your password must not contain your email address.",
  breached:
    "This password has appeared in a public data breach. Please choose a different one.",
  common_password: "This password is too easy to guess. Please choose a different one.",
  repeated_characters: "This password is too easy to guess. Please choose a different one.",
  sequential_characters: "This password is too easy to guess. Please choose a different one.",
  contains_product_name: "Your password must not contain the name of this product.",
};
