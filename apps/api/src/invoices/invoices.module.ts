import { Module } from "@nestjs/common";

import { EINVOICE_PROVIDER } from "./einvoice/einvoice.types.js";
import { NoopEInvoiceProvider } from "./einvoice/noop-einvoice.provider.js";
import { FircController } from "./firc/firc.controller.js";
import { FircService } from "./firc/firc.service.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";
import { BillingEventsListener } from "./listeners/billing-events.listener.js";
import { NumberingService } from "./numbering.service.js";
import { InvoiceSignatureService } from "./signature.service.js";
import { TaxRegistrationsController } from "./tax-registrations/tax-registrations.controller.js";
import { TaxRegistrationsService } from "./tax-registrations/tax-registrations.service.js";
import { AdminModule } from "../admin/admin.module.js";
import { TaxModule } from "../tax/tax.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Invoices, credit notes, FIRC records and tax registrations (B05).
 *
 * Depends on `TaxModule` for `TaxEngineService`; `AdminModule` for
 * `AdminGuard` (tax-registrations and FIRC routes are platform-staff only);
 * `WorkspacesModule` for `WorkspaceMemberGuard`. `PrismaService`,
 * `DERIVED_STORE`/`ObjectStore` (`CommonModule`) and `MAIL_PROVIDER`
 * (`NotifyModule`) are all `@Global()` already, so nothing extra is imported
 * for them (the same reasoning `billing.module.ts`'s own doc-comment gives).
 * `EventEmitter2` (`EventEmitterModule.forRoot()`, registered once in
 * `app.module.ts`) is global too — `BillingEventsListener` injects it
 * implicitly through `@OnEvent`.
 */
@Module({
  imports: [TaxModule, AdminModule, WorkspacesModule],
  controllers: [InvoicesController, TaxRegistrationsController, FircController],
  providers: [
    NumberingService,
    InvoiceSignatureService,
    InvoicesService,
    TaxRegistrationsService,
    FircService,
    BillingEventsListener,
    { provide: EINVOICE_PROVIDER, useClass: NoopEInvoiceProvider },
  ],
  exports: [InvoicesService, NumberingService, TaxRegistrationsService, FircService],
})
export class InvoicesModule {}
