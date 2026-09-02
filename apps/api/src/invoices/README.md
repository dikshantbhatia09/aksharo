# `invoices` — Rule 46 invoices, credit notes, e-invoicing hook, FIRC, tax registrations (B05)

Everything that turns a paid webhook event into a legally-shaped Indian tax
document: numbering, tax computation (`../tax/`), PDF rendering and signing,
storage, an e-invoicing (IRN/QR) hook, FIRC records and admin-editable tax
registrations.

Design references: `03-architecture/04-pricing-and-monetization.md` v2 §Tax;
`06-data-model.md` (invoices, payments, firc_records, tax_registrations);
`12-redesign-decisions.md` D41; `04-research/RR-05-payments-tax.md`;
`apps/api/prisma/sql/0003-checks.sql` (Rule 46 CHECK constraints, A03-shipped).

## Tax rules, as implemented (`../tax/`)

| Supply                                                           | Place of supply                             | Rate                          |
| ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| B2C, India, same State as supplier                               | Recorded billing State (D41)                | CGST 9% + SGST 9%             |
| B2C/B2B, India, different State                                  | GSTIN's State (B2B) or recorded State (B2C) | IGST 18%                      |
| Non-Indian recipient                                             | Recipient's country                         | 0%, LUT endorsement           |
| SEZ (explicit assertion only — nothing detects it automatically) | Recipient's country                         | 0%                            |
| Import of service (self-invoice, RCM)                            | Supplier's own State                        | 0% output tax, reverse charge |

Place of supply ladder: **GSTIN → recorded State → billing address**
(`place-of-supply.ts`) — collapsed to two rungs because
`workspaces/tax-profile.ts` already makes "recorded State" and "billing
address" the same validated field. **India B2C invoices with no recorded
State hard-fail** (`invoices/state_required`, 422) — never silently defaulted.

GST-inclusive back-computation (Rule 35, `inclusive-tax.ts`): `tax = total ×
rateBps / (10_000 + rateBps)`, rounded half-away-from-zero; CGST/SGST split by
`floor(tax/2)` / remainder so the two always sum to the whole tax exactly;
`roundOffMinor` is computed, not hard-coded to zero, so a future line-item
split cannot silently drop a paisa.

USD exchange rate: `ExchangeRateProvider` interface
(`tax/exchange-rate.ts`), `ManualFallbackExchangeRateProvider` today — no live
RBI feed credentials exist in this environment, the same posture
`billing/providers/provider.factory.ts` takes for Razorpay. **[Finance]** keep
the fallback table current, or wire a real daily fetch behind the same
interface.

## Numbering (`numbering.service.ts`, `invoices.constants.ts`)

One Postgres **`SEQUENCE`** per `(series, fiscalYear)` — `INVOICE_SERIES` maps
each `docType` to a 2-character series code (`IN`, `EX`, `BS`, `CR`, `DR`,
`SI`). A sequence is created lazily, the first time its pair is asked for, under
`pg_advisory_xact_lock(hashtext(seqName))` so two concurrent "first ever"
callers cannot race the `CREATE SEQUENCE`; `nextval()` itself is then called
with **no lock at all** — the entire reason to use a database sequence.
Proven by `test/invoices.e2e-spec.ts`'s 200-parallel test: unique, gap-free,
1..200.

**Format (orchestrator ruling, B05b).** The brief's own `AKS/26-27/IN/000123`
example was 19 characters against Rule 46(b)'s cap on the _whole_ printed
serial number, so `invoices.number` now stores the FULL composed identifier —
`formatInvoiceNumber(series, fiscalYear, sequenceNo)` builds
`AK2627-IN-000123`: brand prefix (2) + fiscal year with no separator (4) + `-`

- series (2) + `-` + zero-padded sequence (6) = 16 characters exactly, which
  is what `prisma/sql/0003-checks.sql`'s `invoices_number_length_check` was
  always meant to bind. The bare integer the string was built from is kept
  separately in `invoices.sequenceNo` (added by migration
  `20260902080000_b05b_invoice_number_format`) for GSTR-1 tooling and the
  concurrency test. `bill_of_supply`'s series is `BS`, not the more obvious
  `BOS` — three characters would make the composed number 17. Fiscal year is
  April–March (`fiscal-year.ts`).

## PDF (`pdf/`)

`pdfkit`, no headless browser. One column, top to bottom, one labelled line per
Rule 46 particular — deliberately, so the golden-PDF tests are substring
checks on extracted text rather than a layout-aware parse. Every particular:
supplier (name, address, GSTIN, State, PAN), recipient (name, address, GSTIN
or "Unregistered (B2C)", State), place of supply + State name, HSN/SAC,
description, reverse-charge flag, taxable value, tax rate, CGST/SGST or IGST
amounts, total tax, total (incl. GST) with the Rule 35 note, round-off, the LUT
export endorsement verbatim when applicable, the e-invoice IRN/ack/QR block
when populated, and a "Digitally Signed" block.

Amounts are printed as `"Rs 699.00"` / `"$19.00"`, not `"₹699.00"` — the
renderer uses only `pdfkit`'s standard fonts (no embedding), and the Rupee
sign is outside WinAnsiEncoding; Helvetica silently substitutes an unrelated
glyph for it. ASCII is unambiguous on every viewer and every text-extraction
path.

Text extraction for the golden-PDF tests is `pdf/pdf-text-extract.ts`, a
small, dependency-free `Tj`/`TJ`-operator reader — **not** the obvious
`pdf-parse`: it throws `bad XRef entry` on a perfectly valid PDF the moment
`zlib` has been used anywhere earlier in the same process (reproduced in
isolation, no `pdfkit` involved), and something in Vitest's own dependency
graph touches `zlib` before any test body runs. See the file's doc-comment.

## Signature (`signature.service.ts`)

"Detached" literally: a small JSON record (algorithm, key id, base64
signature, SHA-256 of the exact stored PDF bytes, timestamp) stored **next
to** the PDF (`invoices.signatureKey`) — not a real PAdES incremental-update
signature (`pdfkit` has no PAdES/CMS support). The PDF's own visible
"Digitally Signed" block is written _before_ hashing and therefore cannot
include the hash/signature themselves (that would be circular); it carries
only the signer name, a signature id and a timestamp, all known upfront.

Key: HMAC-SHA256 over `INTERNAL_CALLBACK_SECRET` by default (already a
required 32+-byte secret); an optional, non-contract `INVOICE_SIGNING_KEY`
environment variable overrides it (an HMAC passphrase, or an RSA private key
PEM for RSA-SHA256) — read directly from `process.env`, not through the frozen
`Env` schema, because `docs/CONTRACTS.md` §1 could not be touched by this work
package.

## E-invoicing hook (`einvoice/`)

`EInvoiceProvider` interface, `NoopEInvoiceProvider` (throws — a caller that
reaches it despite the flag being off is a bug), and
`einvoice-payload.builder.ts` (the government IRP JSON schema, approximate —
**[CA]** verify against the live schema before this is ever wired to a real
GSP). Gated on `FEATURE_FLAGS_JSON.einvoice_enabled` (off by default, same
flag-read pattern `auth/breached-password.service.ts` uses); never submitted
for B2C (RR-05 D6: e-invoicing applies to B2B/export/SEZ, not B2C). A GSP
failure never fails invoice generation — logged, and the invoice is issued
without an IRN.

## FIRC records and tax registrations

`firc/firc.service.ts`: one row per settled USD payment
(`recordSettlement`), plus `GET /admin/firc-records/csv?month=YYYY-MM` (EDF
regime placeholder, RR-05 E4 — filing mechanics are still pending an AD-bank
SOP as of the research this brief is built on).

`tax-registrations/`: `/admin/tax-registrations` (`AdminGuard`, platform
staff only) — admin-editable GSTIN/LUT rows; no automatic registration flow,
because filing GST/LUT is an offline human act. `warnIfLutMissingForUsd`
(called on module boot) logs a startup warning when USD (export) activity
exists with no valid LUT on file.

## Triggering (billing events, not a fork)

`billing/webhooks.service.ts` (B01, outside this work package's declared file
boundary) emits five `EventEmitter2` events — `billing.subscription.charged`
(first charge and renewal), `billing.order.paid`, `billing.pass.paid`,
`billing.payment.refunded` — right after its own existing "processed"
transitions, unchanged otherwise. `listeners/billing-events.listener.ts`
subscribes and calls `InvoicesService.generateInvoice`/`generateCreditNote`.
Contract types live in `billing-events.ts`; see its doc-comment for the full
file-boundary deviation this required and why (setup instructions: "register
listeners, do not fork the state machine"). Every `billing.e2e-spec.ts` test
(B01's own suite) still passes unmodified.

## Deviations and open questions (report these, don't hide them)

1. **Resolved by orchestrator ruling (B05b).** The brief's own numbering
   example, `AKS/26-27/IN/000123`, was 19 characters against Rule 46(b)'s cap
   on the whole printed serial number. `invoices.number` now stores the full
   `AK2627-IN-000123` (16 chars exactly); the bare sequence integer moved to
   its own `sequenceNo` column. See "Numbering" above. Accountant sign-off on
   the final format is tracked as **HUMAN-ACTIONS H-18**.
2. **Default SAC code (`998316`) is a placeholder.** RR-05 open question 2:
   the exact SAC for this supply was never confirmed. **[CA]** required.
3. **Supplier legal name/address/PAN are optional, non-contract environment
   variables** (`SUPPLIER_LEGAL_NAME`, `SUPPLIER_ADDRESS_LINE1`, …,
   `supplier-config.ts`), defaulting to obvious placeholders. **[Company
   Secretary]** set the real registered-office details before the first real
   invoice.
4. **Invoice/credit-note email bypasses `NotifyService`'s `NotifyKind`
   catalogue**, using `MailProvider` directly with custom copy. Reusing the
   closest existing kind (`export-ready`) would have sent "the file is kept
   for N days, then deleted" on a document this same work package must retain
   72 months and exempt from every purge; adding a new kind would edit
   `notify.kinds.test.ts`'s hard-pinned ten-value list
   ("the ten templates the brief names"), outside this work package's
   boundary. Delivery is therefore best-effort and does not get the queue's
   retry/backoff — logged, not thrown, on failure.
5. **SEZ is never auto-detected** — nothing in the data model carries an SEZ
   flag. `determinePlaceOfSupply({isSez: true})` exists for a future caller
   that knows; nothing in this work package sets it.
6. **`import_rcm` self-invoice generation is data-model support only** (tax
   computation, `docType: "self_invoice"`, `INVOICE_SERIES.self_invoice`) —
   per the brief, "generation optional"; no automatic trigger creates one.
7. **e-invoice payload schema is unverified against the live IRP schema**
   (**[CA]**) — this work package had no way to check it against a real
   account.
