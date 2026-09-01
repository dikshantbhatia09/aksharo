import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type Prisma, PrismaClient } from "@prisma/client";

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

  constructor() {
    super({
      // Query text only, never parameters: parameters are user media, transcripts
      // and credentials (THREAT-MODEL T21).
      log: [
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("database connected");
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
