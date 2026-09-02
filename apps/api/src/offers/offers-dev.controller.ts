import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { OFFERS_ERRORS } from "./offers.constants.js";
import {
  ConsumeSignupGiftDevDto,
  consumeSignupGiftDevSchema,
  SimulateNinePassPaymentDto,
  simulateNinePassPaymentSchema,
} from "./offers.dto.js";
import { zodBody } from "../auth/dto/openapi.js";
import { FIRST_EXPORT_PRICE_INR_MINOR } from "../billing/billing.constants.js";
import { BILLING_PROVIDER, type BillingProvider } from "../billing/provider.js";
import { FakeProvider } from "../billing/providers/fake.provider.js";
import { WebhooksService } from "../billing/webhooks.service.js";
import { AppException, PrismaService } from "../common/index.js";

/**
 * `POST /offers/dev/*` — dev/test-only. Registered under `BillingModule` (not
 * `OffersModule`; see `offers.controller.ts`'s doc comment) because
 * {@link simulateNinePassPayment} needs `BILLING_PROVIDER` and
 * `WebhooksService`.
 *
 * **No auth guard, on purpose.** Every other mutating route in this codebase
 * wears `JwtAuthGuard`/`WorkspaceMemberGuard` (THREAT-MODEL T4); these two do
 * not, because the Playwright e2e that drives them runs the real web app
 * against the real API in a separate OS process from the browser, and this
 * codebase's session lives in an httpOnly cookie the web app's own BFF route
 * (`app/api/session`) holds server-side — not a bearer token the test's HTTP
 * client can attach to a direct cross-origin call to the API. Both routes are
 * self-limiting instead: {@link simulateNinePassPayment} only accepts a
 * `passPurchaseId`, an unguessable ULID a caller can only have by already
 * having completed the real, authenticated checkout call that returned it;
 * {@link consumeSignupGift} only flips one boolean-shaped column
 * (`signup_gift_consumed_at`) for a workspace id the caller already knows.
 * Both refuse outright unless `BILLING_PROVIDER` actually resolves to
 * `FakeProvider` — never true with live Razorpay keys wired in
 * (`providers/provider.factory.ts`) — which is this repository's existing
 * signal for "this is a dev/test environment," used the same way
 * `test/billing-harness.ts` already relies on it. Reported as a deviation
 * rather than left unexplained.
 */
@ApiTags("offers")
@Controller("offers/dev")
export class OffersDevController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly webhooks: WebhooksService,
  ) {}

  private requireFakeProvider(): FakeProvider {
    if (this.provider instanceof FakeProvider) return this.provider;
    throw new AppException(
      OFFERS_ERRORS.devSimulatorUnavailable,
      "This endpoint only exists against the fake billing provider.",
      HttpStatus.FORBIDDEN,
    );
  }

  /**
   * Replays the `order.paid` webhook a real Razorpay delivery would send,
   * through the exact same `WebhooksService.handleRazorpay` path `POST
   * /billing/webhooks/razorpay` uses — the same pattern
   * `test/billing.e2e-spec.ts` already exercises in-process, exposed over
   * HTTP so the Playwright e2e can simulate "the buyer completed Razorpay
   * Checkout" without a real Razorpay account or a real browser able to load
   * `checkout.js`.
   */
  @Post("simulate-nine-pass-payment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Dev/test only: simulate a ₹9 pass payment landing (FakeProvider environments)",
    operationId: "simulateNinePassPayment",
  })
  @ApiBody(zodBody(simulateNinePassPaymentSchema))
  @ApiOkResponse({
    description: "The webhook outcome, same shape as `POST /billing/webhooks/razorpay`.",
  })
  @ApiForbiddenResponse({
    description: "`offers/dev_simulator_unavailable` — a live provider is wired.",
  })
  @ApiConflictResponse({ description: "`offers/pass_purchase_not_found`." })
  async simulateNinePassPayment(
    @Body() body: SimulateNinePassPaymentDto,
  ): Promise<{ status: string }> {
    const provider = this.requireFakeProvider();

    const pass = await this.prisma.passPurchase.findFirst({
      where: { id: body.passPurchaseId, kind: "first_export" },
    });
    if (pass === null || pass.providerOrderId === null) {
      throw new AppException(
        OFFERS_ERRORS.passPurchaseNotFound,
        "No such ₹9 pass order.",
        HttpStatus.CONFLICT,
      );
    }

    const emitted = provider.emitWebhook({
      event: "order.paid",
      providerOrderId: pass.providerOrderId,
      amountMinor: FIRST_EXPORT_PRICE_INR_MINOR,
      currency: "INR",
    });
    return this.webhooks.handleRazorpay(Buffer.from(emitted.rawBody), emitted.signature);
  }

  /**
   * Marks the signup gift already spent, so an e2e test can exercise the ₹9
   * upsell (which only shows once the gift is gone) without first driving a
   * full watermark-free browser export through the editor.
   */
  @Post("consume-signup-gift")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Dev/test only: mark a workspace's signup gift already spent",
    operationId: "devConsumeSignupGift",
  })
  @ApiBody(zodBody(consumeSignupGiftDevSchema))
  @ApiOkResponse({ description: "`{ consumed: true }`." })
  async consumeSignupGift(@Body() body: ConsumeSignupGiftDevDto): Promise<{ consumed: true }> {
    this.requireFakeProvider();
    await this.prisma.workspace.update({
      where: { id: body.workspaceId },
      data: { signupGiftConsumedAt: new Date() },
    });
    return { consumed: true };
  }
}
