import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { CommissionService } from "../commission.service.js";
import { FraudService } from "../fraud.service.js";
import {
  INVOICE_AFFILIATE_EVENTS,
  type CreditNoteIssuedEvent,
  type InvoiceIssuedEvent,
} from "../invoice-events.js";

/**
 * Subscribes to the invoice events `invoices/invoices.service.ts` emits
 * (`invoice-events.ts`) and drives the commission engine — the "observe, do
 * not fork" relationship this work package has to invoice generation, the
 * same shape `invoices/listeners/billing-events.listener.ts` has to the
 * billing webhook state machine.
 */
@Injectable()
export class InvoiceEventsListener {
  private readonly logger = new Logger(InvoiceEventsListener.name);

  constructor(
    private readonly commissions: CommissionService,
    private readonly fraud: FraudService,
  ) {}

  @OnEvent(INVOICE_AFFILIATE_EVENTS.invoiceIssued)
  async onInvoiceIssued(event: InvoiceIssuedEvent): Promise<void> {
    try {
      await this.commissions.onInvoiceIssued({
        invoiceId: event.invoiceId,
        workspaceId: event.workspaceId,
        taxableValueMinor: event.taxableValueMinor,
        issuedAt: new Date(event.issuedAt),
      });
    } catch (error) {
      this.logger.error(
        { event, err: error instanceof Error ? error.message : String(error) },
        "commission recording failed",
      );
    }
  }

  @OnEvent(INVOICE_AFFILIATE_EVENTS.creditNoteIssued)
  async onCreditNoteIssued(event: CreditNoteIssuedEvent): Promise<void> {
    try {
      const affiliateId = await this.commissions.onCreditNoteIssued({
        originalInvoiceId: event.originalInvoiceId,
        refundTaxableValueMinor: event.refundTaxableValueMinor,
      });
      if (affiliateId !== null) await this.fraud.checkRefundRatio(affiliateId);
    } catch (error) {
      this.logger.error(
        { event, err: error instanceof Error ? error.message : String(error) },
        "clawback failed",
      );
    }
  }
}
