import PDFDocument from "pdfkit";

import { formatMoney } from "./money-format.js";
import { gstState } from "../../workspaces/gst-state-codes.js";

import type { $Enums } from "@prisma/client";

/**
 * Server-rendered invoice/credit-note PDF (brief §3): every Rule 46 particular,
 * the GST break-up, "incl. GST" display, HSN/SAC, and a visible "Digitally
 * signed" block. `pdfkit` — no headless browser (D33/brief: "headless-free").
 *
 * Deliberately one column, top to bottom, one labeled line per particular:
 * this is what makes `text-extraction test asserts every Rule 46 particular`
 * (acceptance criterion 1) a substring check on the extracted text rather than
 * a fragile layout-aware parse.
 */

export interface PostalAddressLike {
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly postalCode?: string | undefined;
  readonly country: string;
}

export interface InvoicePdfParty {
  readonly legalName: string;
  readonly address: PostalAddressLike;
  readonly gstin?: string | null | undefined;
  readonly stateCode?: string | null | undefined;
  readonly pan?: string | null | undefined;
  readonly email?: string | null | undefined;
}

export interface InvoicePdfInput {
  readonly docType: $Enums.InvoiceDocType;
  /** The formatted, human-readable number: `AKS/26-27/IN/000123`. */
  readonly displayNumber: string;
  readonly issuedAt: Date;
  readonly supplier: InvoicePdfParty;
  readonly recipient: InvoicePdfParty;
  readonly recipientCountry: string;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyCountry: string;
  readonly supplyType: $Enums.SupplyType;
  readonly reverseCharge: boolean;
  readonly sacCode: string;
  readonly itemDescription: string;
  readonly currency: $Enums.Currency;
  readonly exchangeRateToInr?: number | null | undefined;
  readonly taxableValueMinor: number;
  readonly discountMinor: number;
  readonly taxRateBps: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly cessMinor: number;
  readonly totalTaxMinor: number;
  readonly totalMinor: number;
  readonly roundOffMinor: number;
  readonly lutNumber?: string | null | undefined;
  readonly exportEndorsementText?: string | null | undefined;
  /** Credit/debit notes only. */
  readonly relatedInvoiceDisplayNumber?: string | null | undefined;
  readonly reasonCode?: string | null | undefined;
  /** E-invoicing (IRN/QR) hook, populated only when `einvoice_enabled` (brief §4). */
  readonly irn?: string | null | undefined;
  readonly irnAckNo?: string | null | undefined;
  readonly irnAckDate?: Date | null | undefined;
  readonly signedQrPayload?: string | null | undefined;
  /**
   * Everything the VISIBLE signature block can show without circularity: it is
   * written before the PDF is hashed, so it can never include the hash or the
   * signature value taken over these exact bytes (`InvoiceSignatureService`
   * signs the PDF produced here — a document cannot contain a hash of itself).
   * The full detached record (hash, algorithm, base64 signature) is computed
   * straight after and stored alongside the PDF (`invoices.signatureKey`); a
   * verifier checks the two together.
   */
  readonly signatureBlock: {
    readonly signerName: string;
    readonly signatureId: string;
    readonly signedAt: Date;
  };
}

const DOC_TITLES: Record<$Enums.InvoiceDocType, string> = {
  tax_invoice: "TAX INVOICE",
  export_invoice: "EXPORT INVOICE",
  bill_of_supply: "BILL OF SUPPLY",
  credit_note: "CREDIT NOTE",
  debit_note: "DEBIT NOTE",
  self_invoice: "SELF INVOICE (REVERSE CHARGE)",
};

function stateLabel(stateCode: string | null): string {
  if (stateCode === null) return "N/A (outside India)";
  const state = gstState(stateCode);
  return state === undefined ? stateCode : `${state.name} (${stateCode})`;
}

function addressLines(address: PostalAddressLike): string {
  return [
    address.line1,
    address.line2,
    `${address.city}${address.postalCode ? `, ${address.postalCode}` : ""}`,
    address.country,
  ]
    .filter((line): line is string => line !== undefined && line.trim() !== "")
    .join(", ");
}

/**
 * Renders the PDF and resolves with its bytes.
 *
 * `compress: false` is deliberate, not an oversight: `pdfkit`'s stream
 * compression and this repository's PDF text-extraction test dependency
 * (`pdf-parse`, itself built on an old `pdfjs-dist`) turn out not to share a
 * process safely — a `zlib.deflateSync` call earlier in the same process
 * (which `pdfkit`'s compressed-stream path makes) leaves `pdf-parse` unable to
 * read the PDF's xref table (`bad XRef entry`), reproducibly, even on a
 * byte-identical, previously-valid file re-read fresh from disk. Reproduced in
 * isolation (`zlib.deflateSync` alone before `pdf-parse`, no `pdfkit`
 * involved) — it is a `zlib`/`pdf-parse` interaction, not a `pdfkit` bug.
 * Uncompressed invoice PDFs are a handful of KB larger, immaterial for a
 * single-page or few-page text document, and it removes the whole failure
 * class rather than papering over one call site.
 */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  writeInvoiceBody(doc, input);
  doc.end();
  return done;
}

function writeInvoiceBody(doc: PDFKit.PDFDocument, input: InvoicePdfInput): void {
  const line = (text: string, options?: PDFKit.Mixins.TextOptions): void => {
    doc.text(text, options);
  };

  doc.fontSize(18).text(DOC_TITLES[input.docType], { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10);

  // --- Document identity (Rule 46(a)/(b)/(c)) ---
  line(`Invoice No: ${input.displayNumber}`);
  line(`Date of Issue: ${input.issuedAt.toISOString().slice(0, 10)}`);
  if (
    input.relatedInvoiceDisplayNumber !== null &&
    input.relatedInvoiceDisplayNumber !== undefined
  ) {
    line(`Original Invoice No: ${input.relatedInvoiceDisplayNumber}`);
  }
  if (input.reasonCode !== null && input.reasonCode !== undefined) {
    line(`Reason: ${input.reasonCode}`);
  }
  doc.moveDown(0.75);

  // --- Supplier (Rule 46(a)) ---
  doc.fontSize(11).text("Supplier", { underline: true });
  doc.fontSize(10);
  line(input.supplier.legalName);
  line(addressLines(input.supplier.address));
  if (input.supplier.gstin !== null && input.supplier.gstin !== undefined) {
    line(`GSTIN: ${input.supplier.gstin}`);
  }
  if (input.supplier.stateCode !== null && input.supplier.stateCode !== undefined) {
    line(`Supplier State: ${stateLabel(input.supplier.stateCode)}`);
  }
  if (input.supplier.pan !== null && input.supplier.pan !== undefined) {
    line(`PAN: ${input.supplier.pan}`);
  }
  doc.moveDown(0.75);

  // --- Recipient (Rule 46(e)/(f)) ---
  doc.fontSize(11).text("Recipient (Bill To)", { underline: true });
  doc.fontSize(10);
  line(input.recipient.legalName);
  line(addressLines(input.recipient.address));
  line(`Recipient Country: ${input.recipientCountry}`);
  if (input.recipient.gstin !== null && input.recipient.gstin !== undefined) {
    line(`Recipient GSTIN: ${input.recipient.gstin}`);
  } else {
    line("Recipient GSTIN: Unregistered (B2C)");
  }
  if (input.recipient.stateCode !== null && input.recipient.stateCode !== undefined) {
    line(`Recipient State: ${stateLabel(input.recipient.stateCode)}`);
  }
  doc.moveDown(0.75);

  // --- Place of supply, HSN/SAC, reverse charge (Rule 46(f)/(k)/(m)) ---
  doc.fontSize(11).text("Supply Details", { underline: true });
  doc.fontSize(10);
  line(
    `Place of Supply: ${stateLabel(input.placeOfSupplyStateCode)}, ${input.placeOfSupplyCountry}`,
  );
  line(`Supply Type: ${input.supplyType}`);
  line(`HSN/SAC: ${input.sacCode}`);
  line(`Description: ${input.itemDescription}`);
  line(`Reverse Charge Applicable: ${input.reverseCharge ? "Yes" : "No"}`);
  doc.moveDown(0.75);

  // --- Money, GST-inclusive display (s.33 CGST / Rule 35) ---
  doc.fontSize(11).text("Amount", { underline: true });
  doc.fontSize(10);
  if (input.discountMinor > 0) {
    line(`Discount: ${formatMoney(input.discountMinor, input.currency)}`);
  }
  line(`Taxable Value: ${formatMoney(input.taxableValueMinor, input.currency)}`);
  line(`Tax Rate: ${(input.taxRateBps / 100).toFixed(2)}%`);
  if (input.cgstMinor > 0 || input.sgstMinor > 0) {
    line(
      `CGST @ ${(input.taxRateBps / 200).toFixed(2)}%: ${formatMoney(input.cgstMinor, input.currency)}`,
    );
    line(
      `SGST @ ${(input.taxRateBps / 200).toFixed(2)}%: ${formatMoney(input.sgstMinor, input.currency)}`,
    );
  }
  if (input.igstMinor > 0) {
    line(
      `IGST @ ${(input.taxRateBps / 100).toFixed(2)}%: ${formatMoney(input.igstMinor, input.currency)}`,
    );
  }
  if (input.cessMinor > 0) {
    line(`Cess: ${formatMoney(input.cessMinor, input.currency)}`);
  }
  line(`Total Tax: ${formatMoney(input.totalTaxMinor, input.currency)}`);
  if (input.roundOffMinor !== 0) {
    line(`Round Off: ${formatMoney(input.roundOffMinor, input.currency)}`);
  }
  doc.fontSize(12).text(`Total (incl. GST): ${formatMoney(input.totalMinor, input.currency)}`, {
    underline: true,
  });
  doc.fontSize(9).text("Prices shown are inclusive of GST (s.33 CGST, Rule 35).");
  if (
    input.currency === "USD" &&
    input.exchangeRateToInr !== null &&
    input.exchangeRateToInr !== undefined
  ) {
    doc.fontSize(10).text(`Exchange Rate: 1 USD = Rs ${input.exchangeRateToInr.toFixed(4)}`);
  }
  doc.moveDown(0.75);

  // --- Export under LUT endorsement (D41, RR-05 E2) ---
  if (input.exportEndorsementText !== null && input.exportEndorsementText !== undefined) {
    doc.fontSize(10).text(input.exportEndorsementText, { align: "left" });
    if (input.lutNumber !== null && input.lutNumber !== undefined) {
      line(`LUT No: ${input.lutNumber}`);
    }
    doc.moveDown(0.5);
  }

  // --- E-invoicing IRN/QR hook (brief §4) ---
  if (input.irn !== null && input.irn !== undefined) {
    doc.fontSize(11).text("e-Invoice", { underline: true });
    doc.fontSize(10);
    line(`IRN: ${input.irn}`);
    if (input.irnAckNo !== null && input.irnAckNo !== undefined) line(`Ack No: ${input.irnAckNo}`);
    if (input.irnAckDate !== null && input.irnAckDate !== undefined) {
      line(`Ack Date: ${input.irnAckDate.toISOString().slice(0, 10)}`);
    }
    if (input.signedQrPayload !== null && input.signedQrPayload !== undefined) {
      line(`Signed QR Payload: ${input.signedQrPayload}`);
    }
    doc.moveDown(0.75);
  }

  // --- Digital signature block (brief §3) ---
  // Deliberately omits the hash/signature value themselves: those are computed
  // over these exact final bytes AFTER rendering (see `signatureBlock`'s
  // doc-comment) and live in the detached signature record next to the PDF.
  doc.fontSize(11).text("Digitally Signed", { underline: true });
  doc.fontSize(9);
  line(`Digitally signed by: ${input.signatureBlock.signerName}`);
  line(`Signature ID: ${input.signatureBlock.signatureId}`);
  line(`Signed At: ${input.signatureBlock.signedAt.toISOString()}`);
  line(
    "This document is issued with a computer-generated digital signature (detached, over this " +
      "document's hash) and does not require a physical signature.",
  );
}
