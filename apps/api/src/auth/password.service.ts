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
export type PasswordRejection = "too_short" | "too_long" | "contains_email" | "breached";

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
   * Structural password policy (NIST SP 800-63B: length, no composition rules).
   * The breach check is separate because it is a network call and feature-flagged.
   */
  check(password: string, email: string): PasswordRejection | undefined {
    if (password.length < PASSWORD_MIN_LENGTH) return "too_short";
    if (password.length > PASSWORD_MAX_LENGTH) return "too_long";
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    if (local.length >= 3 && password.toLowerCase().includes(local)) return "contains_email";
    return undefined;
  }

  /** {@link check}, as an exception. */
  assertAcceptable(password: string, email: string): void {
    const rejection = this.check(password, email);
    if (rejection === undefined) return;
    throw new AppException(
      AUTH_ERRORS.weakPassword,
      rejection === "too_short"
        ? `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`
        : rejection === "too_long"
          ? `Use at most ${String(PASSWORD_MAX_LENGTH)} characters.`
          : "Your password must not contain your email address.",
      HttpStatus.BAD_REQUEST,
      { reason: rejection, minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
    );
  }
}
