import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { MEMBERSHIP_SEAT_EVENTS, type SeatsChangedEvent } from "./membership-events.js";
import { SeatBillingService } from "./seat-billing.service.js";

/**
 * Subscribes to `workspaces.membership.seats_changed` (`membership-events.ts`)
 * and reacts with {@link SeatBillingService.sync}. Kept as its own class,
 * exactly like `invoices/listeners/billing-events.listener.ts`, so a handler
 * that must never throw back into `EventEmitter2` is separate from the service
 * that does the (fallible) work — `SeatBillingService.sync` already swallows
 * its own errors, so this class is a thin, testable seam rather than a second
 * place errors could leak from.
 */
@Injectable()
export class SeatBillingListener {
  constructor(private readonly seatBilling: SeatBillingService) {}

  @OnEvent(MEMBERSHIP_SEAT_EVENTS.seatsChanged)
  async onSeatsChanged(event: SeatsChangedEvent): Promise<void> {
    await this.seatBilling.sync(event.workspaceId, event.reason);
  }
}
