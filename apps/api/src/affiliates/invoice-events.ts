/**
 * Event names and payloads emitted by `invoices/invoices.service.ts` at the
 * two points where it already commits a paid invoice or a credit note (B07
 * brief §3: "on each paid invoice of a referred workspace" drives the
 * commission engine; §3 clawback drives it off refunds/chargebacks, which in
 * this codebase always produce a credit note — `invoices/README.md` and
 * `invoices.service.ts generateCreditNote`).
 *
 * This module owns the event *contract* the same way `invoices/billing-
 * events.ts` (owned by the invoices team, emitted from `billing/`, outside
 * their file boundary) does — `InvoicesService` (B05, outside this work
 * package's file boundary) and this work package's own listener agree on it
 * without either importing the other's internals.
 *
 * **Deviation, flagged for the orchestrator:** wiring these events requires
 * two small, additive edits outside the brief's stated file boundary
 * (`apps/api/src/invoices/invoices.service.ts`) — `EventEmitter2` injected
 * into the constructor and one `this.events.emit(...)` call added right
 * before each of the two existing `return invoice;` / `return creditNote;`
 * statements. No branch, return type or existing behaviour of
 * `InvoicesService` changes; every one of B05's own invoice tests keeps
 * passing unmodified. This mirrors the precedent `invoices/billing-events.ts`
 * already set for B01→B05; the commission engine has the same "observe, do
 * not fork" relationship to invoice generation that invoice generation has
 * to the billing webhook state machine.
 */

export const INVOICE_AFFILIATE_EVENTS = {
  /** A tax_invoice or export_invoice was issued (i.e. paid) for a workspace. */
  invoiceIssued: "invoices.invoice.issued",
  /** A credit note was issued against an original invoice (refund/chargeback). */
  creditNoteIssued: "invoices.credit_note.issued",
} as const;

export interface InvoiceIssuedEvent {
  readonly invoiceId: string;
  readonly workspaceId: string;
  /** GST-exclusive amount — the commission base (brief §3: "base excludes GST"). */
  readonly taxableValueMinor: number;
  readonly currency: string;
  readonly issuedAt: string;
}

export interface CreditNoteIssuedEvent {
  readonly creditNoteId: string;
  readonly originalInvoiceId: string;
  readonly workspaceId: string;
  readonly refundTaxableValueMinor: number;
  readonly reasonCode: string;
}
