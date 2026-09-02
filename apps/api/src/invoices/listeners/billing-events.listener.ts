import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { PrismaService } from "../../common/index.js";
import {
  BILLING_INVOICE_EVENTS,
  type OrderPaidEvent,
  type PassPaidEvent,
  type PaymentRefundedEvent,
  type SubscriptionChargedEvent,
} from "../billing-events.js";
import { InvoicesService } from "../invoices.service.js";

/**
 * Subscribes to the billing events `billing/webhooks.service.ts` emits
 * (`invoices/billing-events.ts`) and turns each into an invoice or credit
 * note. This is the "register listeners, do not fork the state machine" half
 * of the setup instructions — `WebhooksService`'s own state transitions are
 * untouched; this class only reacts after they have already committed.
 *
 * Handlers never throw back into the emitter (`EventEmitter2`'s default
 * behaviour on a rejected async listener is an unhandled rejection, which
 * would take the whole process down for what is a best-effort side effect of
 * a webhook that has already been fully processed and acknowledged) — every
 * handler catches and logs.
 */
@Injectable()
export class BillingEventsListener {
  private readonly logger = new Logger(BillingEventsListener.name);

  constructor(
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent(BILLING_INVOICE_EVENTS.subscriptionCharged)
  async onSubscriptionCharged(event: SubscriptionChargedEvent): Promise<void> {
    await this.safely("subscriptionCharged", event, async () => {
      const plan = await this.planNameFor(event.subscriptionId);
      await this.invoices.generateInvoice({
        workspaceId: event.workspaceId,
        subscriptionId: event.subscriptionId,
        totalMinor: event.amountMinor,
        currency: event.currency,
        itemDescription: `${plan} subscription — ${event.isFirstCharge ? "first charge" : "renewal"}`,
      });
    });
  }

  @OnEvent(BILLING_INVOICE_EVENTS.orderPaid)
  async onOrderPaid(event: OrderPaidEvent): Promise<void> {
    await this.safely("orderPaid", event, async () => {
      const plan = await this.planNameFor(event.subscriptionId);
      await this.invoices.generateInvoice({
        workspaceId: event.workspaceId,
        subscriptionId: event.subscriptionId,
        totalMinor: event.amountMinor,
        currency: event.currency,
        itemDescription: `${plan} — one-time purchase`,
      });
    });
  }

  @OnEvent(BILLING_INVOICE_EVENTS.passPaid)
  async onPassPaid(event: PassPaidEvent): Promise<void> {
    await this.safely("passPaid", event, async () => {
      await this.invoices.generateInvoice({
        workspaceId: event.workspaceId,
        passPurchaseId: event.passPurchaseId,
        totalMinor: event.amountMinor,
        currency: event.currency,
        itemDescription: `Aksharo ${event.kind.replace(/_/g, " ")}`,
      });
    });
  }

  @OnEvent(BILLING_INVOICE_EVENTS.paymentRefunded)
  async onPaymentRefunded(event: PaymentRefundedEvent): Promise<void> {
    await this.safely("paymentRefunded", event, async () => {
      if (event.invoiceId === null) {
        this.logger.warn(
          { paymentId: event.paymentId },
          "refund has no linked invoice; no credit note raised",
        );
        return;
      }
      const original = await this.prisma.invoice.findUnique({ where: { id: event.invoiceId } });
      // Every refund gets a credit note (brief §2), linked to the original.
      if (original === null) {
        this.logger.warn(
          { invoiceId: event.invoiceId },
          "payment refunded but no invoice found to credit-note against",
        );
        return;
      }
      await this.invoices.generateCreditNote({
        originalInvoiceId: original.id,
        refundAmountMinor: event.amountMinor,
        reasonCode: event.reasonCode ?? "payment_refunded",
      });
    });
  }

  private async planNameFor(subscriptionId: string): Promise<string> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: { select: { name: true } } },
    });
    return subscription?.plan.name ?? "Aksharo";
  }

  private async safely<E>(name: string, event: E, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        {
          event: name,
          payload: event,
          err: error instanceof Error ? error.message : String(error),
        },
        "invoice generation from a billing event failed",
      );
    }
  }
}
