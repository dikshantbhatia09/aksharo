/**
 * Integration acceptance tests (brief acceptance criteria 2, and the
 * concurrency/hard-fail/credit-note/LUT/IRN items from §8) against a real
 * PostgreSQL — a Postgres `SEQUENCE`'s concurrency guarantee cannot be proven
 * against a mock, and neither can the `invoices_india_state_code_check`
 * CHECK constraint.
 */
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { isDatabaseAvailable, skipReason as dbSkipReason } from "./db-harness.js";
import {
  createInvoicesTestContext,
  invoicesSkipReason,
  type InvoicesTestContext,
} from "./invoices-harness.js";
import { isRedisAvailable } from "./redis-harness.js";
import { AppModule } from "../src/app.module.js";
import { HttpExceptionFilter } from "../src/common/errors/http-exception.filter.js";
import { resetEnvCache } from "../src/config/config.module.js";
import { EINVOICE_PROVIDER } from "../src/invoices/einvoice/einvoice.types.js";
import { InvoicesService } from "../src/invoices/invoices.service.js";
import { NumberingService } from "../src/invoices/numbering.service.js";
import { RetentionService } from "../src/media/retention.service.js";

import type { EInvoiceProvider } from "../src/invoices/einvoice/einvoice.types.js";
import type { INestApplication } from "@nestjs/common";

const DB_READY = isDatabaseAvailable() && isRedisAvailable();

describe.skipIf(!DB_READY)("invoices — B05 acceptance", () => {
  let ctx: InvoicesTestContext | null = null;

  beforeAll(async () => {
    ctx = await createInvoicesTestContext();
    if (ctx === null) {
      console.warn(`[invoices.e2e-spec] skipped: ${invoicesSkipReason || dbSkipReason}`);
    }
  }, 180_000);

  it("setup", () => {
    if (ctx === null) return;
    expect(ctx.workspaceId).toBeDefined();
  });

  // -------------------------------------------------------------------
  // Acceptance criterion 2: 200 parallel invoices in one series produce
  // unique, consecutive numbers.
  // -------------------------------------------------------------------
  it("allocates 200 concurrent numbers in one series/fiscalYear with no collisions and no gaps", async () => {
    if (ctx === null) return;
    const numbering = ctx.app.get(NumberingService);
    const series = "TS"; // isolated series so this test never collides with others in the file
    const fiscalYear = "26-27";

    const results = await Promise.all(
      Array.from({ length: 200 }, async () => numbering.nextNumber(series, fiscalYear)),
    );

    const unique = new Set(results);
    expect(unique.size).toBe(200);

    const numeric = results.map((value) => Number(value)).sort((a, b) => a - b);
    expect(numeric[0]).toBe(1);
    expect(numeric[numeric.length - 1]).toBe(200);
    // No gaps: consecutive integers 1..200.
    for (let i = 1; i < numeric.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      expect(numeric[i]).toBe((numeric[i - 1] ?? 0) + 1);
    }
  }, 60_000);

  // -------------------------------------------------------------------
  // B2C India hard failure without recipientStateCode.
  // -------------------------------------------------------------------
  it("hard-fails an India B2C invoice with no recorded billing State", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const workspaceId = await ctx.createWorkspace({ billingCountry: "IN", billingStateCode: null });

    await expect(
      invoices.generateInvoice({
        workspaceId,
        totalMinor: 69_900,
        currency: "INR",
        itemDescription: "Aksharo Creator monthly subscription",
      }),
    ).rejects.toMatchObject({ code: "invoices/state_required" });
  });

  // -------------------------------------------------------------------
  // Tax rules table, end to end: intra-state, inter-state, export/LUT.
  // -------------------------------------------------------------------
  it("issues an intra-state India B2C tax invoice with CGST+SGST and a stored, downloadable PDF", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const invoice = await invoices.generateInvoice({
      workspaceId: ctx.workspaceId,
      totalMinor: 69_900,
      currency: "INR",
      itemDescription: "Aksharo Creator monthly subscription",
    });

    expect(invoice.docType).toBe("tax_invoice");
    expect(invoice.supplyType).toBe("intra_state");
    expect(invoice.cgstMinor).toBeGreaterThan(0);
    expect(invoice.sgstMinor).toBeGreaterThan(0);
    expect(invoice.igstMinor).toBe(0);
    expect(invoice.recipientStateCode).toBe("27");
    expect(invoice.pdfKey).not.toBeNull();
    expect(invoice.signatureKey).not.toBeNull();
    expect(invoice.number).toMatch(/^AK\d{4}-IN-\d{6}$/); // Rule 46(b): full identifier, 16 chars
    expect(invoice.number.length).toBeLessThanOrEqual(16);
    expect(invoice.sequenceNo).toBeGreaterThan(0);

    const url = await invoices.getDownloadUrl(invoice.id, ctx.workspaceId);
    expect(url).toMatch(/^https?:\/\//);
  });

  it("issues an inter-state India B2B tax invoice with IGST only", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const workspaceId = await ctx.createWorkspace({
      billingCountry: "IN",
      billingStateCode: "29",
      gstin: "29AAGCB7383J1Z4",
    });

    const invoice = await invoices.generateInvoice({
      workspaceId,
      totalMinor: 199_900,
      currency: "INR",
      itemDescription: "Aksharo Agency seat",
    });

    expect(invoice.supplyType).toBe("inter_state");
    expect(invoice.igstMinor).toBeGreaterThan(0);
    expect(invoice.cgstMinor).toBe(0);
    expect(invoice.sgstMinor).toBe(0);
    expect(invoice.recipientGstin).toBe("29AAGCB7383J1Z4");
  });

  it("issues a USD export invoice under LUT, zero-rated, with the endorsement and LUT number", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const invoice = await invoices.generateInvoice({
      workspaceId: ctx.usdWorkspaceId,
      totalMinor: 1_900,
      currency: "USD",
      itemDescription: "Aksharo Creator monthly subscription",
    });

    expect(invoice.docType).toBe("export_invoice");
    expect(invoice.supplyType).toBe("export");
    expect(invoice.totalTaxMinor).toBe(0);
    expect(invoice.exportEndorsementText).toBe(
      "SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF INTEGRATED TAX",
    );
    expect(invoice.lutNumber).toBe("AD270825001234A");
    expect(invoice.exchangeRateToInr).not.toBeNull();
  });

  // -------------------------------------------------------------------
  // Credit note linkage and totals.
  // -------------------------------------------------------------------
  it("links a credit note to its original invoice with matching totals", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const original = await invoices.generateInvoice({
      workspaceId: ctx.workspaceId,
      totalMinor: 69_900,
      currency: "INR",
      itemDescription: "Aksharo Creator monthly subscription",
    });

    const creditNote = await invoices.generateCreditNote({
      originalInvoiceId: original.id,
      refundAmountMinor: 69_900,
      reasonCode: "subscription_refund",
    });

    expect(creditNote.docType).toBe("credit_note");
    expect(creditNote.relatedInvoiceId).toBe(original.id);
    expect(creditNote.reasonCode).toBe("subscription_refund");
    expect(creditNote.totalMinor).toBe(original.totalMinor);
    expect(creditNote.taxableValueMinor + creditNote.totalTaxMinor + creditNote.roundOffMinor).toBe(
      creditNote.totalMinor,
    );
    expect(creditNote.recipientLegalName).toBe(original.recipientLegalName);
    expect(creditNote.series).not.toBe(original.series); // credit_note series, not tax_invoice's
  });

  it("supports a partial-amount credit note", async () => {
    if (ctx === null) return;
    const invoices = ctx.app.get(InvoicesService);
    const original = await invoices.generateInvoice({
      workspaceId: ctx.workspaceId,
      totalMinor: 199_900,
      currency: "INR",
      itemDescription: "Aksharo Studio monthly subscription",
    });

    const creditNote = await invoices.generateCreditNote({
      originalInvoiceId: original.id,
      refundAmountMinor: 50_000,
      reasonCode: "partial_refund",
    });

    expect(creditNote.totalMinor).toBe(50_000);
    expect(creditNote.totalMinor).toBeLessThan(original.totalMinor);
  });
});

// ---------------------------------------------------------------------
// e-invoicing (IRN/QR) hook flag behaviour — its own app instance so the
// flag can be set before boot without disturbing the suite above.
// ---------------------------------------------------------------------
describe.skipIf(!DB_READY)("invoices — e-invoicing hook flag", () => {
  it("populates irn/irnAckNo/irnAckDate/signedQrPayload only when einvoice_enabled is true", async () => {
    const ctx = await createInvoicesTestContext();
    if (ctx === null) return;

    try {
      // A second app instance, same database, with the flag on and a stub
      // EInvoiceProvider standing in for a real GSP.
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ einvoice_enabled: true });
      resetEnvCache();

      const stubProvider: EInvoiceProvider = {
        async generateIrn() {
          return {
            irn: "35054cc24d95e3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            irnAckNo: "112010001234567",
            irnAckDate: new Date("2026-09-02T06:00:00.000Z"),
            signedQrPayload: "eyJTZWxsZXJHc3RpbiI6IjI3QUFQRlUwOTM5RjFaViJ9",
          };
        },
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EINVOICE_PROVIDER)
        .useValue(stubProvider)
        .compile();
      const flaggedApp: INestApplication = moduleRef.createNestApplication({
        logger: false,
        rawBody: true,
      });
      flaggedApp.useGlobalFilters(new HttpExceptionFilter());
      await flaggedApp.init();

      try {
        const invoices = flaggedApp.get(InvoicesService);
        // B2B (has a GSTIN) — e-invoicing applies to B2B/export, not B2C (RR-05 D6).
        const workspaceId = await ctx.createWorkspace({
          billingCountry: "IN",
          billingStateCode: "29",
          gstin: "29AAGCB7383J1Z4",
        });
        const invoice = await invoices.generateInvoice({
          workspaceId,
          totalMinor: 199_900,
          currency: "INR",
          itemDescription: "Aksharo Agency seat",
        });

        expect(invoice.irn).toBe("35054cc24d95e3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1");
        expect(invoice.irnAckNo).toBe("112010001234567");
        expect(invoice.signedQrPayload).not.toBeNull();

        // B2C, same flag: e-invoicing is not applicable (RR-05 D6) — no IRN.
        const b2cInvoice = await invoices.generateInvoice({
          workspaceId: ctx.workspaceId,
          totalMinor: 69_900,
          currency: "INR",
          itemDescription: "Aksharo Creator monthly subscription",
        });
        expect(b2cInvoice.irn).toBeNull();
      } finally {
        await flaggedApp.close();
      }
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = "{}";
      resetEnvCache();
      await ctx.stop();
    }
  }, 60_000);

  it("leaves irn null by default (flag off)", async () => {
    const ctx = await createInvoicesTestContext();
    if (ctx === null) return;
    try {
      const invoices = ctx.app.get(InvoicesService);
      const workspaceId = await ctx.createWorkspace({
        billingCountry: "IN",
        billingStateCode: "29",
        gstin: "29AAGCB7383J1Z4",
      });
      const invoice = await invoices.generateInvoice({
        workspaceId,
        totalMinor: 199_900,
        currency: "INR",
        itemDescription: "Aksharo Agency seat",
      });
      expect(invoice.irn).toBeNull();
      expect(invoice.irnAckNo).toBeNull();
      expect(invoice.signedQrPayload).toBeNull();
    } finally {
      await ctx.stop();
    }
  });
});

// ---------------------------------------------------------------------
// Retention exemption: A06's purge service never touches invoices.
// ---------------------------------------------------------------------
describe.skipIf(!DB_READY)("invoices — retention exemption", () => {
  it("is never touched by RetentionService.purgeDueMedia, however overdue", async () => {
    const ctx = await createInvoicesTestContext();
    if (ctx === null) return;
    try {
      const invoices = ctx.app.get(InvoicesService);
      const invoice = await invoices.generateInvoice({
        workspaceId: ctx.workspaceId,
        totalMinor: 69_900,
        currency: "INR",
        itemDescription: "Aksharo Creator monthly subscription",
      });

      const retention = ctx.app.get(RetentionService);
      // A purge sweep dated ten years in the future — as overdue as retention
      // gets — must still leave every invoice field (and its stored PDF key)
      // exactly as it was: `purgeDueMedia` only ever queries `media_assets`.
      const report = await retention.purgeDueMedia({
        now: new Date("2036-01-01T00:00:00.000Z"),
        limit: 1000,
      });
      expect(report).toBeDefined();

      const reloaded = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(reloaded.pdfKey).toBe(invoice.pdfKey);
      expect(reloaded.signatureKey).toBe(invoice.signatureKey);
      expect(reloaded.status).toBe("issued");
    } finally {
      await ctx.stop();
    }
  });
});
