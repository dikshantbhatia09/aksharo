-- B01: idempotency ledger for inbound Razorpay webhooks (THREAT-MODEL T16).
--
-- `event_id` is the provider's own event id; the unique index is what makes a
-- replayed delivery a no-op rather than a second state transition. `mismatch`
-- records that an otherwise validly-signed payload disagreed with our order or
-- subscription on amount or currency, so the row survives even when the event is
-- refused a second effect.

-- AlterEnum
-- A03's `subscriptions.status` (`SubscriptionStatus`) had no state for "checkout
-- created, awaiting the first authentication/charge" — 06 does not enumerate this
-- column (see the schema comment above it), and B01's state machine
-- (04 §Mandates, renewals, dunning; D40) starts one step before `trialing`/
-- `active`. Precedent for extending an enum this way: A06's
-- `ALTER TYPE "MediaRole" ADD VALUE 'subtitle'`.
ALTER TYPE "SubscriptionStatus" ADD VALUE 'pending';

-- CreateEnum
CREATE TYPE "BillingEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- CreateTable
CREATE TABLE "billing_events" (
  "id"           CHAR(26)        NOT NULL,
  "provider"     "BillingProvider" NOT NULL DEFAULT 'razorpay',
  "event_id"     TEXT            NOT NULL,
  "event_type"   TEXT            NOT NULL,
  "payload"      JSONB           NOT NULL,
  "status"       "BillingEventStatus" NOT NULL DEFAULT 'received',
  "mismatch"     BOOLEAN         NOT NULL DEFAULT false,
  "error"        TEXT,
  "received_at"  TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),

  CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_events_event_id_key" ON "billing_events" ("event_id");
CREATE INDEX "billing_events_event_type_idx" ON "billing_events" ("event_type");
CREATE INDEX "billing_events_received_at_idx" ON "billing_events" ("received_at");
