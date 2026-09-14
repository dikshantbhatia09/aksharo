import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type Prisma, PrismaClient } from "@prisma/client";

import { applyPoolBudget, type PoolBudget } from "./pool.js";

/**
 * A transaction client: the same surface as {@link PrismaService} minus the
 * lifecycle and transaction methods, which is what `$transaction` hands a callback.
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface TransactionOptions {
  /** Milliseconds a transaction may hold open before Prisma rolls it back. */
  readonly timeoutMs?: number;
  /** Milliseconds to wait for a free connection before failing. */
  readonly maxWaitMs?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * The Prisma client as an injectable singleton.
 *
 * Owns its own lifecycle: `onModuleInit` connects eagerly so a bad `DATABASE_URL`
 * fails at boot rather than on the first request, and `onModuleDestroy` closes the
 * pool. `app.enableShutdownHooks()` in `main.ts` is what makes the second half
 * actually run on SIGTERM.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** What this process is allowed to open. See `pool.ts`. */
  private readonly poolBudget: PoolBudget;

  constructor() {
    // Prisma's default limit is derived from the host's CPU count, which makes
    // the fleet's total connection use a property of the node size rather than
    // of the replica count — and therefore unknowable until the database runs
    // out. The budget is stated explicitly instead (P0-11).
    const databaseUrl = process.env["DATABASE_URL"];
    const pooled =
      databaseUrl === undefined || databaseUrl === ""
        ? undefined
        : applyPoolBudget(databaseUrl);

    super({
      // Query text only, never parameters: parameters are user media, transcripts
      // and credentials (THREAT-MODEL T21).
      log: [
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ],
      ...(pooled === undefined ? {} : { datasources: { db: { url: pooled.url } } }),
    });

    this.poolBudget = pooled?.budget ?? {
      connectionLimit: 0,
      poolTimeoutSec: 0,
      fromUrl: false,
    };
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      {
        connectionLimit: this.poolBudget.connectionLimit,
        poolTimeoutSec: this.poolBudget.poolTimeoutSec,
        source: this.poolBudget.fromUrl ? "DATABASE_URL" : "DATABASE_POOL_SIZE",
      },
      "database connected",
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside one transaction.
   *
   * Exists so call sites do not each pick their own timeout and isolation level.
   * The credit paths of D32 need `Serializable`; everything else is fine on the
   * database default, so the level is a parameter rather than a house rule.
   */
  async withTransaction<T>(
    fn: (tx: PrismaTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    return this.$transaction(async (tx) => fn(tx), {
      timeout: options.timeoutMs ?? 10_000,
      maxWait: options.maxWaitMs ?? 5_000,
      ...(options.isolationLevel === undefined ? {} : { isolationLevel: options.isolationLevel }),
    });
  }

  /** Cheap round trip used by the readiness probe. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
