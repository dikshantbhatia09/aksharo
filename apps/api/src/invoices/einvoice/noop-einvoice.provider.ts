import { Injectable } from "@nestjs/common";

import type { EInvoicePayload, EInvoiceProvider, EInvoiceResult } from "./einvoice.types.js";

/**
 * The only `EInvoiceProvider` this work package ships (brief §4: "a no-op
 * implementation"). Throws rather than fabricating an IRN — a caller that
 * invokes it despite `einvoice_enabled` being off is a programming error, and
 * a silently-fake IRN on a real invoice would be worse than a loud failure.
 */
@Injectable()
export class NoopEInvoiceProvider implements EInvoiceProvider {
  async generateIrn(_payload: EInvoicePayload): Promise<EInvoiceResult> {
    throw new Error(
      "NoopEInvoiceProvider: no e-invoice (GSP) integration is configured. " +
        "This should only be reachable when einvoice_enabled is true, which this " +
        "work package never sets by default — see FEATURE_FLAGS_JSON.",
    );
  }
}
