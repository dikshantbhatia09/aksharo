import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import { INVOICE_AFFILIATE_EVENTS } from "../affiliates/invoice-events.js";
import { buildEInvoicePayload } from "./einvoice/einvoice-payload.builder.js";
import { EINVOICE_PROVIDER, type EInvoiceProvider } from "./einvoice/einvoice.types.js";
import { fiscalYearFor, gstr1PeriodFor } from "./fiscal-year.js";
import { formatInvoiceNumber, INVOICE_SERIES } from "./invoices.constants.js";
import { NumberingService } from "./numbering.service.js";
import { renderInvoicePdf } from "./pdf/invoice-pdf.renderer.js";
import { InvoiceSignatureService } from "./signature.service.js";
import {
  INVOICE_DOWNLOAD_URL_TTL_SECONDS,
  invoicePdfKey,
  invoiceSignatureKey,
} from "./storage-keys.js";
import { resolveSupplierConfig } from "./supplier-config.js";
import { TaxRegistrationsService } from "./tax-registrations/tax-registrations.service.js";
import { AppException, DERIVED_STORE, PrismaService, type ObjectStore } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { MAIL_PROVIDER, type MailProvider } from "../notify/mail/mail.provider.js";
import { TaxEngineService } from "../tax/tax-engine.service.js";
import { DEFAULT_SAC_CODE } from "../tax/tax.constants.js";
import { validateGstin } from "../workspaces/gstin.js";

import type { InvoicePdfParty, PostalAddressLike } from "./pdf/invoice-pdf.renderer.js";
import type { $Enums, Invoice, Prisma } from "@prisma/client";

/**
 * Invoice generation (brief §2): numbering, tax computation, PDF + signature,
 * storage, e-invoicing hook, and email — the one place all of it comes
 * together for both an ordinary invoice and a credit note.
 */

export interface GenerateInvoiceInput {
  readonly workspaceId: string;
  readonly subscriptionId?: string | null;
  readonly passPurchaseId?: string | null;
  /** GST-inclusive amount actually charged/received. */
  readonly totalMinor: number;
  readonly currency: $Enums.Currency;
  readonly itemDescription: string;
  readonly issuedAt?: Date;
  readonly discountMinor?: number;
  readonly couponCode?: string;
}

export interface GenerateCreditNoteInput {
  readonly originalInvoiceId: string;
  /** GST-inclusive amount refunded. */
  readonly refundAmountMinor: number;
  readonly reasonCode: string;
  readonly issuedAt?: Date;
}

const INVOICES_ERRORS = {
  stateRequired: "invoices/state_required",
  gstinMalformed: "invoices/gstin_malformed",
  noSupplierGstin: "invoices/no_supplier_gstin",
} as const;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly taxEngine: TaxEngineService,
    private readonly signature: InvoiceSignatureService,
    private readonly taxRegistrations: TaxRegistrationsService,
    @Inject(DERIVED_STORE) private readonly store: ObjectStore,
    @Inject(ENV) private readonly env: Env,
    @Inject(EINVOICE_PROVIDER) private readonly einvoice: EInvoiceProvider,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------
  // Ordinary invoices (tax_invoice / export_invoice)
  // ---------------------------------------------------------------------

  async generateInvoice(input: GenerateInvoiceInput): Promise<Invoice> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      include: { owner: { select: { email: true, name: true } } },
    });

    const registration = await this.taxRegistrations.currentIndiaGstin();
    if (registration === null) {
      throw new AppException(
        INVOICES_ERRORS.noSupplierGstin,
        "No GSTIN is on file in tax_registrations; an invoice cannot be issued without one.",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const supplierGstinVerdict = validateGstin(registration.taxId);
    const supplierStateCode = supplierGstinVerdict.ok ? supplierGstinVerdict.stateCode : undefined;
    if (supplierStateCode === undefined) {
      throw new AppException(
        INVOICES_ERRORS.noSupplierGstin,
        "The GSTIN on file in tax_registrations is not valid.",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const issuedAt = input.issuedAt ?? new Date();

    const outcome = await this.taxEngine.compute({
      totalMinor: input.totalMinor,
      currency: input.currency,
      ...(input.discountMinor === undefined ? {} : { discountMinor: input.discountMinor }),
      recipientCountry: workspace.billingCountry,
      recipientGstin: workspace.gstin,
      recipientStateCode: workspace.billingStateCode,
      supplierStateCode,
      exchangeRateAt: issuedAt,
    });
    if (!outcome.ok) {
      // Brief §2: "B2C India invoices require recipientStateCode (hard failure otherwise)".
      const code =
        outcome.problem === "gstin_malformed"
          ? INVOICES_ERRORS.gstinMalformed
          : INVOICES_ERRORS.stateRequired;
      throw new AppException(code, outcome.message, HttpStatus.UNPROCESSABLE_ENTITY, {
        workspaceId: input.workspaceId,
      });
    }
    const tax = outcome.computation;

    const docType: $Enums.InvoiceDocType =
      tax.supplyType === "export" || tax.supplyType === "sez" ? "export_invoice" : "tax_invoice";
    const series = INVOICE_SERIES[docType];
    const fiscalYear = fiscalYearFor(issuedAt);
    const sequenceNo = await this.numbering.nextNumber(series, fiscalYear);
    const displayNumber = formatInvoiceNumber(series, fiscalYear, sequenceNo);
    const invoiceId = ulid();

    const supplierConfig = resolveSupplierConfig();
    const lutRegistration =
      tax.supplyType === "export" ? await this.taxRegistrations.currentLut(issuedAt) : null;
    if (tax.supplyType === "export" && lutRegistration === null) {
      this.logger.warn(
        { workspaceId: input.workspaceId },
        "generating an export invoice with no valid LUT on file — see TaxRegistrationsService.warnIfLutMissingForUsd",
      );
    }

    const recipientAddress = parsePostalAddress(workspace.billingAddress);
    const supplierParty: InvoicePdfParty = {
      legalName: supplierConfig.legalName,
      address: supplierConfig.address,
      gstin: registration.taxId,
      stateCode: supplierStateCode,
      ...(supplierConfig.pan === undefined ? {} : { pan: supplierConfig.pan }),
    };
    const recipientParty: InvoicePdfParty = {
      legalName: workspace.legalName ?? workspace.name,
      address: recipientAddress,
      gstin: workspace.gstin,
      stateCode: workspace.billingStateCode,
      email: workspace.owner.email,
    };

    const signedAt = new Date();
    const pdfBytes = await renderInvoicePdf({
      docType,
      displayNumber,
      issuedAt,
      supplier: supplierParty,
      recipient: recipientParty,
      recipientCountry: workspace.billingCountry,
      placeOfSupplyStateCode: tax.placeOfSupplyStateCode,
      placeOfSupplyCountry: tax.placeOfSupplyCountry,
      supplyType: tax.supplyType,
      reverseCharge: tax.reverseCharge,
      sacCode: DEFAULT_SAC_CODE,
      itemDescription: input.itemDescription,
      currency: input.currency,
      exchangeRateToInr: tax.exchangeRateToInr,
      taxableValueMinor: tax.taxableValueMinor,
      discountMinor: tax.discountMinor,
      taxRateBps: tax.taxRateBps,
      cgstMinor: tax.cgstMinor,
      sgstMinor: tax.sgstMinor,
      igstMinor: tax.igstMinor,
      cessMinor: tax.cessMinor,
      totalTaxMinor: tax.totalTaxMinor,
      totalMinor: tax.totalMinor,
      roundOffMinor: tax.roundOffMinor,
      lutNumber: lutRegistration?.lutNumber ?? null,
      exportEndorsementText: tax.exportEndorsementText,
      signatureBlock: { signerName: supplierConfig.legalName, signatureId: invoiceId, signedAt },
    });

    const signatureRecord = this.signature.sign(pdfBytes, supplierConfig.legalName);
    const pdfKey = invoicePdfKey(input.workspaceId, invoiceId);
    const sigKey = invoiceSignatureKey(input.workspaceId, invoiceId);
    await this.store.put({ key: pdfKey, body: pdfBytes, contentType: "application/pdf" });
    await this.store.put({
      key: sigKey,
      body: JSON.stringify(signatureRecord),
      contentType: "application/json",
    });

    const einvoiceFields = await this.tryGenerateIrn({
      docType,
      number: displayNumber,
      issuedAt,
      supplierGstin: registration.taxId,
      supplierLegalName: supplierConfig.legalName,
      supplierAddressLine: supplierConfig.address.line1,
      supplierCity: supplierConfig.address.city,
      supplierPincode: Number(supplierConfig.address.postalCode ?? "0") || 0,
      supplierStateCode,
      recipientGstin: workspace.gstin,
      recipientLegalName: recipientParty.legalName,
      recipientAddressLine: recipientAddress.line1,
      recipientCity: recipientAddress.city,
      placeOfSupplyStateCode: tax.placeOfSupplyStateCode ?? supplierStateCode,
      sacCode: DEFAULT_SAC_CODE,
      itemDescription: input.itemDescription,
      reverseCharge: tax.reverseCharge,
      taxableValueMinor: tax.taxableValueMinor,
      cgstMinor: tax.cgstMinor,
      sgstMinor: tax.sgstMinor,
      igstMinor: tax.igstMinor,
      totalMinor: tax.totalMinor,
      taxRateBps: tax.taxRateBps,
      isB2c: workspace.gstin === null && tax.supplyType !== "export",
    });

    const invoice = await this.prisma.invoice.create({
      data: {
        id: invoiceId,
        workspaceId: input.workspaceId,
        subscriptionId: input.subscriptionId ?? null,
        passPurchaseId: input.passPurchaseId ?? null,
        docType,
        series,
        number: displayNumber,
        sequenceNo,
        fiscalYear,
        issuedAt,
        supplierLegalName: supplierConfig.legalName,
        supplierAddress: supplierConfig.address as unknown as Prisma.InputJsonValue,
        supplierGstin: registration.taxId,
        supplierStateCode,
        ...(supplierConfig.pan === undefined ? {} : { supplierPan: supplierConfig.pan }),
        recipientLegalName: recipientParty.legalName,
        recipientEmail: workspace.owner.email,
        recipientGstin: workspace.gstin,
        recipientAddress: recipientAddress as unknown as Prisma.InputJsonValue,
        recipientStateCode: tax.placeOfSupplyStateCode ?? workspace.billingStateCode,
        recipientCountry: workspace.billingCountry,
        placeOfSupplyStateCode: tax.placeOfSupplyStateCode,
        placeOfSupplyCountry: tax.placeOfSupplyCountry,
        supplyType: tax.supplyType,
        sacCode: DEFAULT_SAC_CODE,
        itemDescription: input.itemDescription,
        reverseCharge: tax.reverseCharge,
        currency: input.currency,
        exchangeRateToInr: tax.exchangeRateToInr,
        exchangeRateAt: tax.exchangeRateAt,
        taxableValueMinor: tax.taxableValueMinor,
        discountMinor: tax.discountMinor,
        ...(input.couponCode === undefined ? {} : { couponCode: input.couponCode }),
        taxRateBps: tax.taxRateBps,
        cgstMinor: tax.cgstMinor,
        sgstMinor: tax.sgstMinor,
        igstMinor: tax.igstMinor,
        cessMinor: tax.cessMinor,
        totalTaxMinor: tax.totalTaxMinor,
        totalMinor: tax.totalMinor,
        taxInclusiveDisplay: true,
        roundOffMinor: tax.roundOffMinor,
        lutNumber: lutRegistration?.lutNumber ?? null,
        exportEndorsementText: tax.exportEndorsementText,
        ...einvoiceFields,
        signatureKey: sigKey,
        pdfKey,
        status: "issued",
        gstr1Period: gstr1PeriodFor(issuedAt),
      },
    });

    await this.emailInvoice(invoice, workspace.owner.email, displayNumber, pdfKey);
    if (docType === "tax_invoice" || docType === "export_invoice") {
      this.events.emit(INVOICE_AFFILIATE_EVENTS.invoiceIssued, {
        invoiceId: invoice.id,
        workspaceId: invoice.workspaceId,
        taxableValueMinor: invoice.taxableValueMinor,
        currency: invoice.currency,
        issuedAt: invoice.issuedAt.toISOString(),
      });
    }
    return invoice;
  }

  // ---------------------------------------------------------------------
  // Credit notes
  // ---------------------------------------------------------------------

  async generateCreditNote(input: GenerateCreditNoteInput): Promise<Invoice> {
    const original = await this.prisma.invoice.findUniqueOrThrow({
      where: { id: input.originalInvoiceId },
    });
    const issuedAt = input.issuedAt ?? new Date();

    const intraState = original.supplyType === "intra_state";
    const rateBps = original.taxRateBps;
    const totalTaxMinor = Math.round((input.refundAmountMinor * rateBps) / (10_000 + rateBps));
    const taxableValueMinor = input.refundAmountMinor - totalTaxMinor;
    const cgstMinor = intraState ? Math.floor(totalTaxMinor / 2) : 0;
    const sgstMinor = intraState ? totalTaxMinor - cgstMinor : 0;
    const igstMinor = intraState ? 0 : totalTaxMinor;
    const roundOffMinor =
      input.refundAmountMinor - (taxableValueMinor + cgstMinor + sgstMinor + igstMinor);

    const docType: $Enums.InvoiceDocType = "credit_note";
    const series = INVOICE_SERIES[docType];
    const fiscalYear = fiscalYearFor(issuedAt);
    const sequenceNo = await this.numbering.nextNumber(series, fiscalYear);
    const displayNumber = formatInvoiceNumber(series, fiscalYear, sequenceNo);
    // original.number already IS the full Rule 46(b) identifier (B05b) — no reformatting needed.
    const originalDisplayNumber = original.number;
    const invoiceId = ulid();

    const supplierAddress = parsePostalAddress(original.supplierAddress) ?? {
      line1: "",
      city: "",
      country: "IN",
    };
    const recipientAddress = parsePostalAddress(original.recipientAddress) ?? {
      line1: "",
      city: "",
      country: original.recipientCountry,
    };

    const signedAt = new Date();
    const pdfBytes = await renderInvoicePdf({
      docType,
      displayNumber,
      issuedAt,
      supplier: {
        legalName: original.supplierLegalName,
        address: supplierAddress,
        gstin: original.supplierGstin,
        stateCode: original.supplierStateCode,
        pan: original.supplierPan,
      },
      recipient: {
        legalName: original.recipientLegalName,
        address: recipientAddress,
        gstin: original.recipientGstin,
        stateCode: original.recipientStateCode,
        email: original.recipientEmail,
      },
      recipientCountry: original.recipientCountry,
      placeOfSupplyStateCode: original.placeOfSupplyStateCode,
      placeOfSupplyCountry: original.placeOfSupplyCountry,
      supplyType: original.supplyType,
      reverseCharge: original.reverseCharge,
      sacCode: original.sacCode,
      itemDescription: original.itemDescription,
      currency: original.currency,
      exchangeRateToInr:
        original.exchangeRateToInr === null ? null : Number(original.exchangeRateToInr),
      taxableValueMinor,
      discountMinor: 0,
      taxRateBps: rateBps,
      cgstMinor,
      sgstMinor,
      igstMinor,
      cessMinor: 0,
      totalTaxMinor,
      totalMinor: input.refundAmountMinor,
      roundOffMinor,
      relatedInvoiceDisplayNumber: originalDisplayNumber,
      reasonCode: input.reasonCode,
      signatureBlock: {
        signerName: original.supplierLegalName,
        signatureId: invoiceId,
        signedAt,
      },
    });

    const signatureRecord = this.signature.sign(pdfBytes, original.supplierLegalName);
    const pdfKey = invoicePdfKey(original.workspaceId, invoiceId);
    const sigKey = invoiceSignatureKey(original.workspaceId, invoiceId);
    await this.store.put({ key: pdfKey, body: pdfBytes, contentType: "application/pdf" });
    await this.store.put({
      key: sigKey,
      body: JSON.stringify(signatureRecord),
      contentType: "application/json",
    });

    const creditNote = await this.prisma.invoice.create({
      data: {
        id: invoiceId,
        workspaceId: original.workspaceId,
        subscriptionId: original.subscriptionId,
        passPurchaseId: original.passPurchaseId,
        docType,
        series,
        number: displayNumber,
        sequenceNo,
        fiscalYear,
        issuedAt,
        supplierLegalName: original.supplierLegalName,
        supplierAddress: original.supplierAddress as unknown as Prisma.InputJsonValue,
        supplierGstin: original.supplierGstin,
        supplierStateCode: original.supplierStateCode,
        supplierPan: original.supplierPan,
        recipientLegalName: original.recipientLegalName,
        recipientEmail: original.recipientEmail,
        recipientGstin: original.recipientGstin,
        recipientAddress: original.recipientAddress as unknown as Prisma.InputJsonValue,
        recipientStateCode: original.recipientStateCode,
        recipientCountry: original.recipientCountry,
        placeOfSupplyStateCode: original.placeOfSupplyStateCode,
        placeOfSupplyCountry: original.placeOfSupplyCountry,
        supplyType: original.supplyType,
        sacCode: original.sacCode,
        itemDescription: original.itemDescription,
        reverseCharge: original.reverseCharge,
        currency: original.currency,
        exchangeRateToInr: original.exchangeRateToInr,
        exchangeRateAt: original.exchangeRateAt,
        taxableValueMinor,
        discountMinor: 0,
        taxRateBps: rateBps,
        cgstMinor,
        sgstMinor,
        igstMinor,
        cessMinor: 0,
        totalTaxMinor,
        totalMinor: input.refundAmountMinor,
        taxInclusiveDisplay: true,
        roundOffMinor,
        relatedInvoiceId: original.id,
        reasonCode: input.reasonCode,
        signatureKey: sigKey,
        pdfKey,
        status: "issued",
        gstr1Period: gstr1PeriodFor(issuedAt),
      },
    });

    if (original.recipientEmail !== null) {
      await this.emailInvoice(creditNote, original.recipientEmail, displayNumber, pdfKey);
    }
    this.events.emit(INVOICE_AFFILIATE_EVENTS.creditNoteIssued, {
      creditNoteId: creditNote.id,
      originalInvoiceId: original.id,
      workspaceId: original.workspaceId,
      refundTaxableValueMinor: taxableValueMinor,
      reasonCode: input.reasonCode,
    });
    return creditNote;
  }

  // ---------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------

  /**
   * `expectedWorkspaceId` closes an IDOR: `WorkspaceMemberGuard` only proves
   * the caller belongs to the workspace their own token names, not that
   * `invoiceId` belongs to it — a guessed/enumerated ULID from another
   * workspace must 404, not hand back a signed URL to someone else's invoice.
   */
  async getDownloadUrl(invoiceId: string, expectedWorkspaceId: string): Promise<string> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (invoice === null || invoice.workspaceId !== expectedWorkspaceId) {
      throw new AppException(
        "invoices/not_found",
        "No invoice with that id in this workspace.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (invoice.pdfKey === null) {
      throw new AppException(
        "invoices/no_pdf",
        "This invoice has no generated PDF yet.",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.store.presignGet(invoice.pdfKey, INVOICE_DOWNLOAD_URL_TTL_SECONDS);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Best-effort IRN generation, gated on `FEATURE_FLAGS_JSON.einvoice_enabled`
   * (brief §4) — the same flag-read pattern `auth/breached-password.service.ts`
   * uses for its own flag. B2C is never submitted (RR-05 D6: e-invoicing
   * applies to B2B/export/SEZ/deemed export, not B2C). A failure here never
   * fails invoice generation — the PDF and the invoice row are already valid
   * without an IRN; `NoopEInvoiceProvider` always throws, so with the flag on
   * and no real GSP configured, generation logs a warning and moves on.
   */
  private async tryGenerateIrn(
    input: Parameters<typeof buildEInvoicePayload>[0] & { readonly isB2c: boolean },
  ): Promise<Partial<Pick<Invoice, "irn" | "irnAckNo" | "irnAckDate" | "signedQrPayload">>> {
    const enabled = this.env.FEATURE_FLAGS_JSON["einvoice_enabled"] === true;
    if (!enabled || input.isB2c) return {};

    try {
      const payload = buildEInvoicePayload(input);
      const result = await this.einvoice.generateIrn(payload);
      return {
        irn: result.irn,
        irnAckNo: result.irnAckNo,
        irnAckDate: result.irnAckDate,
        signedQrPayload: result.signedQrPayload,
      };
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "e-invoice IRN generation failed; invoice is issued without one",
      );
      return {};
    }
  }

  /**
   * Sends the invoice/credit-note by mail (brief §3: "emailed via the notify
   * interface").
   *
   * Uses `MailProvider` (`notify/mail/mail.provider.ts`) directly rather than
   * `NotifyService.enqueue`'s closed `NotifyKind` catalogue. Two reasons, both
   * load-bearing: (1) `NOTIFY_KINDS` is hard-pinned to exactly ten values by
   * `notify.kinds.test.ts` ("the ten templates the brief names"), which this
   * work package's file boundary does not include and must not edit; (2) the
   * closest existing kind, `export-ready`, says "the file is kept for {days}
   * days, then deleted" — false for a document this same work package must
   * retain 72 months and exempt from every purge. `MAIL_PROVIDER` is exported
   * `@Global()` by `NotifyModule`, so this is still "the notify interface" —
   * its mail transport — just not the templated, queued half of it. Delivery
   * is best-effort: a failure is logged, not thrown, so a transient mail
   * outage never fails an otherwise-complete invoice.
   */
  private async emailInvoice(
    invoice: Invoice,
    to: string,
    displayNumber: string,
    pdfKey: string,
  ): Promise<void> {
    try {
      const link = await this.store.presignGet(pdfKey, INVOICE_DOWNLOAD_URL_TTL_SECONDS);
      const kind = invoice.docType === "credit_note" ? "Credit Note" : "Invoice";
      const totalDisplay = `${invoice.currency} ${(invoice.totalMinor / 100).toFixed(2)}`;
      await this.mail.send({
        to,
        subject: `${kind} ${displayNumber}`,
        text:
          `Your ${kind.toLowerCase()} ${displayNumber} (${totalDisplay}) is ready.\n\n` +
          `Download it here (link valid 24 hours): ${link}\n\n` +
          "Billing documents are retained for 72 months and can be re-downloaded from your workspace at any time.",
        html:
          `<p>Your ${kind.toLowerCase()} <strong>${displayNumber}</strong> (${totalDisplay}) is ready.</p>` +
          `<p><a href="${link}">Download it here</a> (link valid 24 hours).</p>` +
          "<p>Billing documents are retained for 72 months and can be re-downloaded from your workspace at any time.</p>",
        idempotencyKey: `invoice:${invoice.id}`,
        tags: { kind: "invoice_document" },
      });
    } catch (error) {
      this.logger.warn(
        { invoiceId: invoice.id, err: error instanceof Error ? error.message : String(error) },
        "invoice email delivery failed; the invoice itself is unaffected",
      );
    }
  }
}

function parsePostalAddress(value: Prisma.JsonValue | null | undefined): PostalAddressLike {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return { line1: "Address not on file", city: "", country: "IN" };
  }
  const record = value as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  return {
    line1: str("line1") ?? "Address not on file",
    ...(str("line2") === undefined ? {} : { line2: str("line2") }),
    city: str("city") ?? "",
    ...(str("postalCode") === undefined ? {} : { postalCode: str("postalCode") }),
    country: str("country") ?? "IN",
  };
}
