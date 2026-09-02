import { Module } from "@nestjs/common";

import { AdminBillingController } from "./admin-billing.controller.js";
import { AdminBillingService } from "./admin-billing.service.js";
import { BillingModule } from "../../billing/billing.module.js";
import { InvoicesModule } from "../../invoices/invoices.module.js";
import { AdminModule } from "../admin.module.js";

/**
 * Its own module, not folded into `AdminModule`, to avoid a module cycle:
 * `InvoicesModule` already imports `AdminModule` (for `AdminGuard` on its own
 * tax-registrations/FIRC routes), so `AdminModule` cannot import
 * `InvoicesModule` back. This module sits one level above both — it imports
 * `AdminModule` (for `AdminGuard`/`AdminRoles`), `BillingModule` (for
 * `RefundsService`) and `InvoicesModule` (for `InvoicesService`) — and is
 * registered in `app.module.ts` after all three.
 */
@Module({
  imports: [AdminModule, BillingModule, InvoicesModule],
  controllers: [AdminBillingController],
  providers: [AdminBillingService],
})
export class AdminBillingModule {}
