import { HttpStatus } from "@nestjs/common";

import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";

/**
 * `CreditsFacade` — the frozen api-internal credit interface (CONTRACTS §4).
 *
 * Every job producer calls {@link CreditsFacade.reserve} *before* it enqueues and
 * {@link CreditsFacade.settle} or {@link CreditsFacade.release} from the completion
 * path. Nothing outside this file may talk to the credit tables, which is what lets
 * B02 replace the implementation without touching a single producer.
 *
 * A08 ships {@link NoopCreditsFacade}; B02 ships the ledger-backed one behind the
 * same interface.
 */
export interface CreditsFacade {
  /**
   * Hold the worst-case cost of a job before it is enqueued.
   *
   * @throws CreditsInsufficientError when the workspace cannot cover the hold.
   */
  reserve(input: ReserveInput): Promise<ReserveResult>;

  /**
   * Charge the actual cost against a hold. Idempotent: settling an already
   * settled hold returns the recorded settlement and moves no credits
   * (THREAT-MODEL T8 — a replayed completion callback must not charge twice).
   *
   * When `actualTenths` exceeds the hold, the implementation may take a delta
   * hold and report it as `deltaHoldId`.
   */
  settle(input: SettleInput): Promise<SettleResult>;

  /** Return a hold to the balance untouched (failure, cancellation, timeout). */
  release(input: ReleaseInput): Promise<void>;

  /**
   * Add credits to a workspace: monthly grant, top-up, pass, referral bonus,
   * adjustment or reversal.
   *
   * Signature only in A08 — the no-op records the lot in memory and returns an id
   * so the Wave 3 producers (B01 top-ups, B04 passes, B07 referrals) can be written
   * against the final shape. B02 implements it against `credit_lots`.
   */
  grantLot(input: GrantLotInput): Promise<GrantLotResult>;
}

export interface ReserveInput {
  readonly workspaceId: string;
  readonly jobId: string;
  /** Tenths of a credit (CONTRACTS §0). */
  readonly worstCaseTenths: number;
  /** Human-readable audit trail, e.g. `"ai.transcribe 12.4 media minutes"`. */
  readonly reason: string;
}

export interface ReserveResult {
  readonly holdId: string;
}

export interface SettleInput {
  readonly holdId: string;
  readonly actualTenths: number;
}

export interface SettleResult {
  readonly settledTenths: number;
  /** Set when the actual cost exceeded the hold and a delta hold was taken. */
  readonly deltaHoldId?: string;
}

export interface ReleaseInput {
  readonly holdId: string;
}

/** Where the credits came from; mirrors the `CreditLotSource` enum of 06. */
export type CreditLotSource = "grant" | "topup" | "pass" | "referral" | "adjust" | "reversal";

export interface GrantLotInput {
  readonly workspaceId: string;
  readonly source: CreditLotSource;
  readonly tenths: number;
  /** Period end for grants; `undefined` (never expires) for top-ups, passes and referrals. */
  readonly expiresAt?: Date;
  readonly reason: string;
  /** Invoice, payment or referral this lot was created for. */
  readonly refId?: string;
}

export interface GrantLotResult {
  readonly lotId: string;
}

/**
 * Thrown by `reserve` when the workspace cannot cover the hold.
 *
 * It is an {@link AppException} so it renders as the CONTRACTS §8 envelope with
 * `credits/insufficient` and HTTP 402 without a producer having to translate it,
 * and it carries the shortfall so the web app can size the top-up prompt.
 */
export class CreditsInsufficientError extends AppException {
  constructor(
    public readonly shortfallTenths: number,
    message = "Not enough credits for this job.",
    details: Record<string, unknown> = {},
  ) {
    super(ERROR_CODES.creditsInsufficient, message, HttpStatus.PAYMENT_REQUIRED, {
      shortfallTenths,
      ...details,
    });
  }
}

/**
 * DI token. A constructor injects the interface, not a class:
 *
 * ```ts
 * constructor(@Inject(CREDITS_FACADE) private readonly credits: CreditsFacade) {}
 * ```
 */
export const CREDITS_FACADE = Symbol("CREDITS_FACADE");
