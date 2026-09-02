/**
 * Wire types for `/billing/*`, `/workspaces/{id}` (tax profile), `/workspaces/{id}/credits`,
 * `/workspaces/{id}/usage` and `/invoices` — mirrored from the API's own Zod schemas
 * (`apps/api/src/billing/billing.dto.ts`, `apps/api/src/workspaces/workspaces.dto.ts`,
 * `apps/api/src/credits/credits.dto.ts`) rather than imported from them: this app has no
 * dependency on `apps/api`, and `packages/api-client` (the usual place a shared type like
 * this would live) is outside this work package's file boundary — see the B03 report's
 * "Deviations" for why this local layer exists instead of extending that package.
 *
 * Money is always integer minor units (paise / cents) per `docs/CONTRACTS.md` §0; credits
 * are integer tenths.
 */

export type Currency = "INR" | "USD";
export type PlanKey = "free" | "starter" | "creator" | "studio" | "agency";
export type BillingInterval = "month" | "year" | "halfyear" | "once";
export type MandateMethod = "upi_autopay" | "card" | "enach";

export interface IntervalPrices {
  readonly month: number;
  readonly year: number;
  readonly halfyear?: number;
}

export interface PlanView {
  readonly key: PlanKey;
  readonly name: string;
  readonly prices: Record<Currency, IntervalPrices>;
  readonly creditsPerMonthTenths: number;
  readonly seatPrice: Record<Currency, number> | null;
  readonly hasHalfyear: { readonly INR: boolean; readonly USD: boolean };
}

export interface CheckoutRequest {
  readonly planKey: PlanKey;
  readonly interval: BillingInterval;
  readonly coupon?: string;
  readonly seats?: number;
  readonly method?: MandateMethod;
}

export interface CheckoutAlternative {
  readonly kind: "halfyear_upi" | "card_once" | "enach";
  readonly interval: BillingInterval;
  readonly method: MandateMethod;
  readonly amountMinor: number;
  readonly currency: Currency;
}

export interface CheckoutResponse {
  readonly subscriptionId: string;
  readonly status: string;
  readonly keyId: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly interval: BillingInterval;
  readonly mandateCapMinor: number | null;
  readonly method: MandateMethod | null;
  readonly providerSubscriptionId?: string;
  readonly providerOrderId?: string;
  readonly prefill?: { readonly email?: string; readonly contact?: string };
  readonly notes?: Record<string, string>;
}

export interface SubscriptionView {
  readonly id: string;
  readonly planKey: PlanKey;
  readonly status: string;
  readonly interval: BillingInterval;
  readonly currency: Currency;
  readonly listPriceMinor: number;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly renewalInitiateAt: string | null;
  readonly graceUntil: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pausedUntil: string | null;
  readonly seats: number;
  readonly mandateId: string | null;
}

export interface MandateView {
  readonly id: string;
  readonly method: MandateMethod;
  readonly maxAmountMinor: number;
  readonly currency: Currency;
  readonly status: string;
  readonly afaRequiredPerDebit: boolean;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface ChangePreview {
  readonly currentListPriceMinor: number;
  readonly newListPriceMinor: number;
  readonly prorationCreditMinor: number;
  readonly amountDueNowMinor: number;
  readonly mandateReRegistrationRequired: boolean;
  readonly currency: Currency;
}

export interface PassCheckoutResponse {
  readonly passPurchaseId: string;
  readonly keyId: string;
  readonly providerOrderId: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly creditsGrantedTenths: number;
}

export interface PaymentMethodView {
  readonly method: string;
  readonly label: string;
  readonly last4?: string;
  readonly network?: string;
  readonly isDefault?: boolean;
}

// --- Tax profile / workspace (A05) ------------------------------------------

export interface TaxProfileRequest {
  readonly billingCountry: string;
  readonly billingStateCode?: string;
  readonly gstin?: string;
  readonly legalName?: string;
}

export interface WorkspaceBillingView {
  readonly id: string;
  readonly currency: Currency;
  readonly billingCountry: string;
  readonly billingCountryConfirmedAt: string | null;
  readonly billingStateCode: string | null;
  readonly gstin: string | null;
  readonly legalName: string | null;
  readonly currencyLocked: boolean;
  readonly role: "owner" | "admin" | "editor" | "viewer";
}

// --- Credits (B02) -----------------------------------------------------------

export type LotSource = "grant" | "topup" | "pass" | "referral" | "adjust" | "reversal";

export interface CreditLot {
  readonly id: string;
  readonly source: LotSource;
  readonly grantedTenths: number;
  readonly remainingTenths: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface CreditsSummary {
  readonly workspaceId: string;
  readonly balanceTenths: number;
  readonly monthlyGrantTenths: number;
  readonly grantResetAt: string | null;
  readonly lots: readonly CreditLot[];
}

export type LedgerKind =
  | "grant"
  | "purchase"
  | "hold"
  | "settle"
  | "release"
  | "reversal"
  | "refund"
  | "adjust"
  | "expire"
  | "referral_bonus";

export interface UsageEntry {
  readonly id: string;
  readonly deltaTenths: number;
  readonly kind: LedgerKind;
  readonly refType: string;
  readonly refId: string | null;
  readonly lotId: string | null;
  readonly balanceAfterTenths: number;
  readonly at: string;
  readonly jobType: string | null;
}

export interface UsagePage {
  readonly items: readonly UsageEntry[];
  readonly nextCursor: string | null;
}

// --- Invoices (B05, in flight — see the invoices-panel resilience notes) ----

export type InvoiceDocType =
  | "tax_invoice"
  | "export_invoice"
  | "bill_of_supply"
  | "credit_note"
  | "debit_note"
  | "self_invoice";

/** `06-data-model.md`'s `invoices` row, the fields the billing history page renders. */
export interface InvoiceRow {
  readonly id: string;
  readonly subscriptionId: string | null;
  readonly passPurchaseId: string | null;
  readonly docType: InvoiceDocType;
  readonly series: string;
  readonly number: string;
  readonly fiscalYear: string;
  readonly issuedAt: string;
  readonly recipientLegalName: string | null;
  readonly recipientGstin: string | null;
  readonly recipientStateCode: string | null;
  readonly recipientCountry: string;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyCountry: string;
  readonly supplyType: "intra_state" | "inter_state" | "export" | "sez" | "import_rcm";
  readonly currency: Currency;
  readonly taxableValueMinor: number;
  readonly taxRateBps: number;
  readonly cgstMinor: number;
  readonly sgstMinor: number;
  readonly igstMinor: number;
  readonly cessMinor: number;
  readonly totalTaxMinor: number;
  readonly totalMinor: number;
  readonly roundOffMinor: number;
  readonly relatedInvoiceId: string | null;
  readonly status: string;
}

export interface InvoiceDownload {
  readonly url: string;
}
