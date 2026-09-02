-- B05b (orchestrator ruling): Rule 46(b) caps the WHOLE printed serial number
-- at 16 characters, not a sub-part of it. `invoices.number` moves from
-- holding only the zero-padded sequence tail to holding the full composed
-- identifier (`AK2627-IN-000123`, 16 chars) built by
-- `invoices/invoices.constants.ts`'s `formatInvoiceNumber`. The bare integer
-- counter that identifier was built from is kept separately so anything that
-- needs it (GSTR-1 tooling, the 200-parallel concurrency test) does not have
-- to re-parse the string.
--
-- No data migration: no real invoice has ever been issued against the old
-- format (B05 shipped this same day; there is no production data), so a
-- default of 0 is a safe placeholder for `sequence_no`, never actually read
-- for any pre-existing row.

ALTER TABLE "invoices" ADD COLUMN "sequence_no" INTEGER NOT NULL DEFAULT 0;
