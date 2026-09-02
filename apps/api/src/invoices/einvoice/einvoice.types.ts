/**
 * `EInvoiceProvider` (brief §4): the IRN/QR hook, not wired to a GSP (GST
 * Suvidha Provider). `NoopEInvoiceProvider` is the only implementation in this
 * work package; a real GSP integration is a drop-in replacement behind the
 * same interface, the same cutover story `BILLING_PROVIDER` and
 * `EXCHANGE_RATE_PROVIDER` use elsewhere in this codebase.
 *
 * RR-05 D6: e-invoicing (IRN/QR) applies at ₹5 crore aggregate turnover, to
 * B2B/export/SEZ/deemed-export supplies — not B2C — flagged **[CA]** to
 * confirm the exact threshold and 30-day reporting rule for FY 2026-27 before
 * this is switched on for real.
 */

export const EINVOICE_PROVIDER = Symbol("MONTAJ_EINVOICE_PROVIDER");

/** The IRP (Invoice Registration Portal) request payload, government e-invoice schema (approximate). */
export interface EInvoicePayload {
  readonly Version: string;
  readonly TranDtls: {
    readonly TaxSch: "GST";
    readonly SupTyp: string;
    readonly RegRev: "Y" | "N";
  };
  readonly DocDtls: {
    readonly Typ: "INV" | "CRN" | "DBN";
    readonly No: string;
    readonly Dt: string;
  };
  readonly SellerDtls: {
    readonly Gstin: string;
    readonly LglNm: string;
    readonly Addr1: string;
    readonly Loc: string;
    readonly Pin: number;
    readonly Stcd: string;
  };
  readonly BuyerDtls: {
    readonly Gstin?: string;
    readonly LglNm: string;
    readonly Addr1: string;
    readonly Loc: string;
    readonly Pos: string;
    readonly Stcd?: string;
  };
  readonly ItemList: readonly {
    readonly SlNo: string;
    readonly PrdDesc: string;
    readonly SacCd: string;
    readonly TotAmt: number;
    readonly AssAmt: number;
    readonly GstRt: number;
    readonly CgstAmt: number;
    readonly SgstAmt: number;
    readonly IgstAmt: number;
    readonly TotItemVal: number;
  }[];
  readonly ValDtls: {
    readonly AssVal: number;
    readonly CgstVal: number;
    readonly SgstVal: number;
    readonly IgstVal: number;
    readonly TotInvVal: number;
  };
}

export interface EInvoiceResult {
  readonly irn: string;
  readonly irnAckNo: string;
  readonly irnAckDate: Date;
  readonly signedQrPayload: string;
}

export interface EInvoiceProvider {
  /** Submits the built payload to the IRP and returns the IRN/QR. */
  generateIrn(payload: EInvoicePayload): Promise<EInvoiceResult>;
}
