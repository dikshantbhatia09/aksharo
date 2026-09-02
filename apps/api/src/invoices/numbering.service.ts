import { Injectable } from "@nestjs/common";

import { PrismaService } from "../common/index.js";

/**
 * Rule 46 numbering: one Postgres **sequence** per `(series, fiscalYear)`
 * (brief §2), so `invoices.number` is allocated the way a database is supposed
 * to hand out gap-free, monotonically increasing, concurrency-safe integers —
 * `nextval()` never blocks two concurrent callers against each other and never
 * hands out the same value twice, which is exactly what the acceptance
 * criterion "200 parallel invoices per series produce unique consecutive
 * numbers" is testing.
 *
 * A sequence is created lazily, the first time its `(series, fiscalYear)` pair
 * is asked for (there is no way to know every future fiscal year up front). The
 * lazy-create step is the only part that needs to be serialized — two
 * concurrent callers racing to `CREATE SEQUENCE IF NOT EXISTS` a sequence that
 * does not exist yet is the one scenario a raw `IF NOT EXISTS` does not fully
 * protect against under Postgres's catalog visibility rules — so it runs inside
 * a transaction holding a `pg_advisory_xact_lock` keyed on the sequence name.
 * Once the sequence exists, `nextval()` itself is called with no lock at all:
 * that is the entire point of a database sequence.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The raw sequence integer (B05b: `invoices.sequence_no`) — pass it to
   * `formatInvoiceNumber` (`invoices.constants.ts`) to build the full,
   * Rule-46-compliant `invoices.number` string.
   */
  async nextNumber(series: string, fiscalYear: string): Promise<number> {
    const seqName = sequenceName(series, fiscalYear);

    // Idempotent: cheap once the sequence already exists (the overwhelming
    // majority of calls, all but the first of each fiscal year per series).
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${seqName}))`;
      await tx.$executeRawUnsafe(
        `CREATE SEQUENCE IF NOT EXISTS "${seqName}" START WITH 1 INCREMENT BY 1 MINVALUE 1`,
      );
    });

    const rows = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT nextval('"${seqName}"') AS n`,
    );
    const value = rows[0]?.n;
    if (value === undefined) {
      throw new Error(`invoice sequence "${seqName}" did not return a value`);
    }
    return Number(value);
  }
}

/**
 * A safe, deterministic Postgres identifier for a `(series, fiscalYear)` pair.
 *
 * Both inputs are drawn from closed sets this codebase controls
 * (`INVOICE_SERIES`, `fiscalYearFor`'s `NN-NN` output), never from a request
 * body, but the charset is still asserted defensively before it is
 * string-interpolated into DDL — an identifier is the one place in this file a
 * parameter placeholder cannot go.
 */
export function sequenceName(series: string, fiscalYear: string): string {
  if (!/^[A-Za-z0-9]{1,8}$/.test(series)) {
    throw new Error(`invoice series "${series}" is not a safe sequence-name component`);
  }
  if (!/^\d{2}-\d{2}$/.test(fiscalYear)) {
    throw new Error(`fiscal year "${fiscalYear}" is not a safe sequence-name component`);
  }
  return `invoice_seq_${series.toLowerCase()}_${fiscalYear.replace("-", "_")}`;
}
