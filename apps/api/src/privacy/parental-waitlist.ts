import { createHash } from "node:crypto";

import { ulid } from "ulid";

import type { $Enums, Prisma } from "@prisma/client";

/**
 * The pure half of the parental-consent waiting list (D60).
 *
 * Separate from `parental-waitlist.service.ts` so `AuthService` — which owns
 * `POST /auth/parental-waitlist` — can build exactly the row that service would
 * build without importing a provider, and so both halves agree on the digest by
 * construction rather than by comment.
 */

export interface WaitlistEntryInput {
  readonly email: string;
  readonly jurisdiction?: $Enums.Jurisdiction;
  readonly ageBracket?: $Enums.AgeBracket;
}

/**
 * The address digest.
 *
 * Deliberately the same computation A04 used for its Redis hash field
 * (`sha256(lowercased, trimmed address)`), so an entry written before the table
 * existed and one written after it land on the same key — which is what makes the
 * migration idempotent and a resubmission harmless.
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** One row, ready for an idempotent `createMany({ skipDuplicates: true })`. */
export function parentalWaitlistRow(
  input: WaitlistEntryInput,
): Prisma.ParentalWaitlistCreateManyInput {
  return {
    id: ulid(),
    emailHash: hashEmail(input.email),
    jurisdiction: input.jurisdiction ?? "OTHER",
    ageBracket: input.ageBracket ?? "minor",
  };
}
