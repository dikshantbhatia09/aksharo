import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../../common/index.js";

import type { $Enums } from "@prisma/client";

/**
 * FIRC records (brief §5): on a USD settlement (Razorpay's international
 * rail), one row per settled payment, plus a monthly CSV export-filing report
 * (EDF regime placeholder — RR-05 E4: SOFTEX replaced by a consolidated
 * monthly EDF from 1 Oct 2026, filing mechanics still pending an AD-bank SOP;
 * this report is a starting point, not a filing integration).
 */

export interface RecordFircSettlementInput {
  readonly paymentId: string;
  readonly provider?: string;
  readonly firaKey?: string | null;
  readonly foreignCurrency: string;
  readonly foreignAmountMinor: number;
  readonly inrAmountMinor: number;
  readonly remittanceDate: Date;
  readonly edfRef?: string | null;
}

const CSV_HEADER = [
  "id",
  "paymentId",
  "provider",
  "firaKey",
  "foreignCurrency",
  "foreignAmountMinor",
  "inrAmountMinor",
  "remittanceDate",
  "edfRef",
  "edpmsStatus",
].join(",");

@Injectable()
export class FircService {
  constructor(private readonly prisma: PrismaService) {}

  async recordSettlement(input: RecordFircSettlementInput) {
    return this.prisma.fircRecord.create({
      data: {
        id: ulid(),
        paymentId: input.paymentId,
        provider: input.provider ?? "razorpay",
        firaKey: input.firaKey ?? null,
        foreignCurrency: input.foreignCurrency,
        foreignAmountMinor: input.foreignAmountMinor,
        inrAmountMinor: input.inrAmountMinor,
        remittanceDate: input.remittanceDate,
        edfRef: input.edfRef ?? null,
        edpmsStatus: "pending",
      },
    });
  }

  async markEdpmsStatus(fircId: string, status: $Enums.EdpmsStatus) {
    return this.prisma.fircRecord.update({ where: { id: fircId }, data: { edpmsStatus: status } });
  }

  /** `month` is `"YYYY-MM"`. CSV of every FIRC whose `remittanceDate` falls in that calendar month. */
  async monthlyCsv(month: string): Promise<string> {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (match === null) throw new Error(`month must be "YYYY-MM", got "${month}"`);
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const start = new Date(Date.UTC(year, monthIndex, 1));
    const end = new Date(Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1));

    const rows = await this.prisma.fircRecord.findMany({
      where: { remittanceDate: { gte: start, lt: end } },
      orderBy: { remittanceDate: "asc" },
    });

    const lines = rows.map((row) =>
      [
        row.id,
        row.paymentId,
        row.provider,
        row.firaKey ?? "",
        row.foreignCurrency,
        row.foreignAmountMinor,
        row.inrAmountMinor,
        row.remittanceDate.toISOString().slice(0, 10),
        row.edfRef ?? "",
        row.edpmsStatus,
      ].join(","),
    );
    return [CSV_HEADER, ...lines].join("\n");
  }
}
