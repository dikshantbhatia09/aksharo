import type { EInvoicePayload } from "./einvoice.types.js";
import type { $Enums } from "@prisma/client";

/**
 * Builds the government e-invoice (IRP) schema payload from an invoice — the
 * "payload builder for the government schema (not wired to a GSP)" the brief
 * asks for (§4). Field names/shape follow the published e-invoice JSON schema
 * (`Version`, `TranDtls`, `DocDtls`, `SellerDtls`, `BuyerDtls`, `ItemList`,
 * `ValDtls`) as summarised by secondary sources — **[CA]** to verify against
 * the live schema before this is ever POSTed to a real IRP.
 */

export interface EInvoiceBuilderInput {
  readonly docType: $Enums.InvoiceDocType;
  readonly number: string;
  readonly issuedAt: Date;
  readonly supplierGstin: string;
  readonly supplierLegalName: string;
  readonly supplierAddressLine: string;
  readonly supplierCity: string;
  readonly supplierPincode: number;
  readonly supplierStateCode: string;
  readonly recipientGstin?: string | null;
  readonly recipientLegalName: string;
  readonly recipientAddressLine: string;
  readonly recipientCity: string;
  readonly placeOfSupplyStateCode: string;
  readonly sacCode: string;
  readonly itemDescription: string;
  readonly reverseCharge: boolean;
  readonly taxableValueMinor: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly totalMinor: number;
  readonly taxRateBps: number;
}

const DOC_TYPE_CODE: Record<$Enums.InvoiceDocType, "INV" | "CRN" | "DBN"> = {
  tax_invoice: "INV",
  export_invoice: "INV",
  bill_of_supply: "INV",
  credit_note: "CRN",
  debit_note: "DBN",
  self_invoice: "INV",
};

function toRupees(minor: number): number {
  return Math.round((minor / 100) * 100) / 100;
}

export function buildEInvoicePayload(input: EInvoiceBuilderInput): EInvoicePayload {
  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: input.recipientGstin !== null && input.recipientGstin !== undefined ? "B2B" : "EXP",
      RegRev: input.reverseCharge ? "Y" : "N",
    },
    DocDtls: {
      Typ: DOC_TYPE_CODE[input.docType],
      No: input.number,
      Dt: formatIrpDate(input.issuedAt),
    },
    SellerDtls: {
      Gstin: input.supplierGstin,
      LglNm: input.supplierLegalName,
      Addr1: input.supplierAddressLine,
      Loc: input.supplierCity,
      Pin: input.supplierPincode,
      Stcd: input.supplierStateCode,
    },
    BuyerDtls: {
      ...(input.recipientGstin !== null && input.recipientGstin !== undefined
        ? { Gstin: input.recipientGstin }
        : {}),
      LglNm: input.recipientLegalName,
      Addr1: input.recipientAddressLine,
      Loc: input.recipientCity,
      Pos: input.placeOfSupplyStateCode,
      Stcd: input.placeOfSupplyStateCode,
    },
    ItemList: [
      {
        SlNo: "1",
        PrdDesc: input.itemDescription,
        SacCd: input.sacCode,
        TotAmt: toRupees(input.taxableValueMinor),
        AssAmt: toRupees(input.taxableValueMinor),
        GstRt: input.taxRateBps / 100,
        CgstAmt: toRupees(input.cgstMinor),
        SgstAmt: toRupees(input.sgstMinor),
        IgstAmt: toRupees(input.igstMinor),
        TotItemVal: toRupees(input.totalMinor),
      },
    ],
    ValDtls: {
      AssVal: toRupees(input.taxableValueMinor),
      CgstVal: toRupees(input.cgstMinor),
      SgstVal: toRupees(input.sgstMinor),
      IgstVal: toRupees(input.igstMinor),
      TotInvVal: toRupees(input.totalMinor),
    },
  };
}

/** `DD/MM/YYYY`, the IRP's date format. */
function formatIrpDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}
