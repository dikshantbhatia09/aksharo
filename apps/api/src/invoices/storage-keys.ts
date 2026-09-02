/**
 * Object-store keys for invoice PDFs and their detached signature records.
 *
 * Not reused from `common/storage/storage.keys.ts` (CONTRACTS §6, frozen,
 * and outside this work package's file boundary): that file's key patterns
 * are all media-shaped (`media/{mediaId}/...`). These follow the same
 * `ws/{workspaceId}/...` prefix convention so retention/derived-store tooling
 * that keys off the workspace prefix still finds them, without touching the
 * frozen file.
 */

export function invoicePdfKey(workspaceId: string, invoiceId: string): string {
  return `ws/${workspaceId}/invoices/${invoiceId}.pdf`;
}

export function invoiceSignatureKey(workspaceId: string, invoiceId: string): string {
  return `ws/${workspaceId}/invoices/${invoiceId}.sig.json`;
}

/** How long an invoice/credit-note download link stays valid: a day, long enough for an email click. */
export const INVOICE_DOWNLOAD_URL_TTL_SECONDS = 24 * 60 * 60;
