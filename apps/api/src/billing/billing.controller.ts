import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  changePlanSchema,
  checkoutResponseSchema,
  checkoutSchema,
  mandateViewSchema,
  passCheckoutSchema,
  planViewSchema,
  subscriptionViewSchema,
  topupCheckoutSchema,
  type ChangePlanDto,
  type ChangePreviewQueryDto,
  type CheckoutDto,
  type PassCheckoutDto,
  type TopupCheckoutDto,
  CheckoutResponse,
  ChangePreview,
  MandateView,
  PassCheckoutResponse,
  SubscriptionView,
} from "./billing.dto.js";
import { CheckoutService } from "./checkout.service.js";
import { PassesService } from "./passes.service.js";
import { type PlanView, PlansService } from "./plans.service.js";
import { SubscriptionService } from "./subscription.service.js";
import { WebhooksService } from "./webhooks.service.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Public, Roles, RolesGuard } from "../common/guards/index.js";
import { context } from "../users/users.controller.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { PaymentMethodView } from "./provider.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request } from "express";

/**
 * `/billing/*` (B01 brief, 07 §Billing). Every route except `GET /billing/plans`
 * and `POST /billing/webhooks/razorpay` is scoped to the caller's own
 * workspace through the access token (`WorkspaceMemberGuard`, no `:id` in these
 * paths — the same shape `/projects/*` uses).
 */
@ApiTags("billing")
@Controller("billing")
export class BillingController {
  constructor(
    private readonly plans: PlansService,
    private readonly checkout: CheckoutService,
    private readonly passes: PassesService,
    private readonly subscriptions: SubscriptionService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Get("plans")
  @Public()
  @ApiOperation({ summary: "The public plan catalogue (INR and USD)", operationId: "listPlans" })
  @ApiOkResponse(zodArrayResponse(planViewSchema, "Active plans."))
  async listPlans(): Promise<PlanView[]> {
    return this.plans.list();
  }

  @Post("checkout")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @ApiOperation({
    summary: "Start a plan checkout",
    description:
      "Mandate cap is always the undiscounted list price (D40). Refused with " +
      "`billing/mandate_cap_exceeded` and `details.alternatives` when a UPI " +
      "Autopay mandate would exceed ₹15,000; refused with " +
      "`billing/tax_profile_required` until the workspace confirms its billing " +
      "country (PUT /workspaces/{id}/tax-profile).",
    operationId: "createCheckout",
  })
  @ApiBody(zodBody(checkoutSchema))
  @ApiOkResponse(zodResponse(checkoutResponseSchema, "Checkout payload for the client SDK."))
  @ApiConflictResponse({
    description: "`billing/mandate_cap_exceeded` or `billing/tax_profile_required`.",
  })
  async createCheckout(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: CheckoutDto,
    @Req() request: Request,
  ): Promise<CheckoutResponse> {
    return this.checkout.checkout(principal.workspaceId, principal.userId, body, context(request));
  }

  @Post("passes/checkout")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Buy a pass (clean export, week pass, pay-once credits)",
    operationId: "createPassCheckout",
  })
  @ApiBody(zodBody(passCheckoutSchema))
  @ApiOkResponse({ description: "Checkout payload for the client SDK." })
  async createPassCheckout(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: PassCheckoutDto,
    @Req() request: Request,
  ): Promise<PassCheckoutResponse> {
    return this.passes.passCheckout(
      principal.workspaceId,
      principal.userId,
      body,
      context(request),
    );
  }

  @Post("topups/checkout")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Buy a credit top-up pack", operationId: "createTopupCheckout" })
  @ApiBody(zodBody(topupCheckoutSchema))
  @ApiOkResponse({ description: "Checkout payload for the client SDK." })
  async createTopupCheckout(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: TopupCheckoutDto,
    @Req() request: Request,
  ): Promise<PassCheckoutResponse> {
    return this.passes.topupCheckout(
      principal.workspaceId,
      principal.userId,
      body,
      context(request),
    );
  }

  @Get("subscription")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "The workspace's current subscription", operationId: "getSubscription" })
  @ApiOkResponse(
    zodResponse(subscriptionViewSchema, "The subscription, or null with no plan on file."),
  )
  async getSubscription(@CurrentUser() principal: AuthPrincipal): Promise<SubscriptionView | null> {
    return this.subscriptions.get(principal.workspaceId);
  }

  @Post("subscription/cancel")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Cancel at period end", operationId: "cancelSubscription" })
  @ApiOkResponse(
    zodResponse(subscriptionViewSchema, "The subscription, set to cancel at period end."),
  )
  @ApiNotFoundResponse({ description: "`billing/subscription_not_found`." })
  async cancelSubscription(
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<SubscriptionView> {
    return this.subscriptions.cancel(principal.workspaceId, principal.userId, context(request));
  }

  @Post("subscription/resume")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Undo a pending cancellation, or unpause",
    operationId: "resumeSubscription",
  })
  @ApiOkResponse(zodResponse(subscriptionViewSchema, "The resumed subscription."))
  async resumeSubscription(
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<SubscriptionView> {
    return this.subscriptions.resume(principal.workspaceId, principal.userId, context(request));
  }

  @Post("subscription/pause")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Skip one billing cycle (once per 12 months)",
    operationId: "pauseSubscription",
  })
  @ApiOkResponse(zodResponse(subscriptionViewSchema, "The paused subscription."))
  @ApiConflictResponse({
    description: "`billing/pause_limit_reached` or `billing/already_paused`.",
  })
  async pauseSubscription(
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<SubscriptionView> {
    return this.subscriptions.pause(principal.workspaceId, principal.userId, context(request));
  }

  @Get("subscription/change-preview")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Proration preview for a plan/interval/seat change",
    operationId: "previewChangePlan",
  })
  @ApiOkResponse({ description: "Proration figures for the requested change." })
  async changePreview(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: ChangePreviewQueryDto,
  ): Promise<ChangePreview> {
    return this.subscriptions.changePreview(principal.workspaceId, query);
  }

  @Post("subscription/change-plan")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Apply a plan/interval/seat change",
    description:
      "Re-registers the mandate with fresh authentication when the new cap exceeds the current one (D40).",
    operationId: "changePlan",
  })
  @ApiBody(zodBody(changePlanSchema))
  @ApiOkResponse({
    description:
      "The updated subscription, or a checkout payload when re-authentication is needed.",
  })
  async changePlan(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ChangePlanDto,
    @Req() request: Request,
  ): Promise<SubscriptionView | CheckoutResponse> {
    return this.subscriptions.changePlan(
      principal.workspaceId,
      principal.userId,
      body,
      context(request),
    );
  }

  @Get("mandates")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Every mandate this workspace has registered",
    operationId: "listMandates",
  })
  @ApiOkResponse(zodArrayResponse(mandateViewSchema, "Mandates, newest first."))
  async listMandates(@CurrentUser() principal: AuthPrincipal): Promise<MandateView[]> {
    return this.subscriptions.listMandates(principal.workspaceId);
  }

  // `:mandateId`, not `:id` — `WorkspaceMemberGuard` treats a literal `id` path
  // param as the workspace id (07 §Conventions; see its own doc comment) and
  // would compare a mandate id against `principal.workspaceId`, which can
  // never match and would 403 every call.
  @Post("mandates/:mandateId/revoke")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("admin")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Revoke a mandate (cancels its subscription)",
    operationId: "revokeMandate",
  })
  @ApiOkResponse(zodResponse(mandateViewSchema, "The revoked mandate."))
  @ApiNotFoundResponse({ description: "`billing/mandate_not_found`." })
  async revokeMandate(
    @CurrentUser() principal: AuthPrincipal,
    @Param("mandateId") id: string,
    @Req() request: Request,
  ): Promise<MandateView> {
    return this.subscriptions.revokeMandate(
      principal.workspaceId,
      id,
      principal.userId,
      context(request),
    );
  }

  @Get("payment-methods")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Payment methods on file with the provider",
    operationId: "listPaymentMethods",
  })
  @ApiOkResponse({ description: "Payment methods, most recently used first." })
  async listPaymentMethods(@CurrentUser() principal: AuthPrincipal): Promise<PaymentMethodView[]> {
    return this.subscriptions.paymentMethods(principal.workspaceId);
  }

  @Post("webhooks/razorpay")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Razorpay webhook (THREAT-MODEL T16)",
    description:
      "Signature-verified, idempotent by event id. A bad signature is 401, never " +
      "200 (a 200 tells Razorpay to stop retrying).",
    operationId: "handleRazorpayWebhook",
  })
  @ApiOkResponse({ description: "Always 200 once the signature verifies, even on a replay." })
  @ApiForbiddenResponse({ description: "Not used; a bad signature is 401." })
  async handleWebhook(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers("x-razorpay-signature") signature: string,
  ): Promise<{ status: string }> {
    return this.webhooks.handleRazorpay(request.rawBody ?? Buffer.from(""), signature ?? "");
  }
}
