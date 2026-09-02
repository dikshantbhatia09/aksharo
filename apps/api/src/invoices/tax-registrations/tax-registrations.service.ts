import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../../common/index.js";

export interface UpsertTaxRegistrationInput {
  readonly jurisdiction: string;
  readonly taxIdType: string;
  readonly taxId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date | null;
  readonly filingCadence?: string;
  readonly lutNumber?: string | null;
  readonly lutValidTo?: Date | null;
}

/**
 * `tax_registrations` (brief §6): admin-editable GSTIN/LUT rows, plus the
 * startup check that warns when no LUT is on file for a workspace that takes
 * USD payments (D41: "GST registration and LUT filed from day one").
 *
 * "Admin-editable" is the whole surface here — there is no automatic
 * registration flow (GST/LUT filing is a human, offline act, brief/RR-05
 * D7/E2) — this service only records what a human has already filed.
 */
@Injectable()
export class TaxRegistrationsService implements OnModuleInit {
  private readonly logger = new Logger(TaxRegistrationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Startup warning (brief §6), run once when the module boots. Never throws — a missing LUT is an operational gap, not a crash. */
  async onModuleInit(): Promise<void> {
    try {
      await this.warnIfLutMissingForUsd();
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "tax_registrations startup check could not run (likely no database yet in this process)",
      );
    }
  }

  async list() {
    return this.prisma.taxRegistration.findMany({
      orderBy: [{ jurisdiction: "asc" }, { taxIdType: "asc" }],
    });
  }

  async upsert(input: UpsertTaxRegistrationInput) {
    const existing = await this.prisma.taxRegistration.findUnique({
      where: {
        jurisdiction_taxIdType_taxId: {
          jurisdiction: input.jurisdiction,
          taxIdType: input.taxIdType,
          taxId: input.taxId,
        },
      },
    });

    const data = {
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      filingCadence: input.filingCadence ?? "monthly",
      lutNumber: input.lutNumber ?? null,
      lutValidTo: input.lutValidTo ?? null,
    };

    if (existing !== null) {
      return this.prisma.taxRegistration.update({ where: { id: existing.id }, data });
    }
    return this.prisma.taxRegistration.create({
      data: {
        id: ulid(),
        jurisdiction: input.jurisdiction,
        taxIdType: input.taxIdType,
        taxId: input.taxId,
        ...data,
      },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.taxRegistration.delete({ where: { id } });
  }

  /** The current GSTIN registration for India, or `null`. Invoices/e-invoicing read supplier GSTIN from here. */
  async currentIndiaGstin() {
    return this.prisma.taxRegistration.findFirst({
      where: { jurisdiction: "IN", taxIdType: "GSTIN" },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /** The current, valid LUT (if any) — `null` when missing or expired as of `asOf`. */
  async currentLut(asOf: Date = new Date()) {
    const registration = await this.currentIndiaGstin();
    if (registration?.lutNumber === null || registration?.lutNumber === undefined) return null;
    if (registration.lutValidTo !== null && registration.lutValidTo < asOf) return null;
    return registration;
  }

  /** `true` when at least one USD-currency invoice or subscription exists — a rough, DB-only proxy for "we take USD payments". */
  private async hasUsdActivity(): Promise<boolean> {
    const count = await this.prisma.subscription.count({ where: { currency: "USD" } });
    return count > 0;
  }

  async warnIfLutMissingForUsd(): Promise<void> {
    const hasUsd = await this.hasUsdActivity();
    if (!hasUsd) return;
    const lut = await this.currentLut();
    if (lut === null) {
      this.logger.warn(
        "STARTUP WARNING: USD (export) activity exists but no valid LUT is on file in " +
          "tax_registrations — export invoices cannot be raised zero-rated under LUT " +
          "without one (D41, RR-05 E2). File Form RFD-11 and record it via " +
          "PUT /admin/tax-registrations.",
      );
    }
  }
}
