-- A05: the tax profile has to record that a human confirmed the billing country,
-- and the parental-consent waiting list needs a durable home.

-- Sign-up guesses `billing_country` from the declared jurisdiction (A04), which is
-- not a statement the customer made. B01 refuses to open a checkout while this is
-- NULL, so an unconfirmed guess can never reach an invoice.
ALTER TABLE "workspaces"
  ADD COLUMN "billing_country_confirmed_at" TIMESTAMPTZ(6);

-- A04 parked waitlist entries in the Redis hash `montaj:auth:parental-waitlist`
-- because the schema was frozen outside A03. Only a hash of the address is kept:
-- the row exists to say that somebody at that address asked to be told when the
-- parental-consent flow ships, and nothing ever reads the address back.
CREATE TABLE "parental_waitlist" (
  "id"           CHAR(26)     NOT NULL,
  "email_hash"   CHAR(64)     NOT NULL,
  "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'OTHER',
  "age_bracket"  "AgeBracket"   NOT NULL DEFAULT 'minor',
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notified_at"  TIMESTAMPTZ(6),

  CONSTRAINT "parental_waitlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parental_waitlist_email_hash_key" ON "parental_waitlist" ("email_hash");
CREATE INDEX "parental_waitlist_created_at_idx" ON "parental_waitlist" ("created_at");
