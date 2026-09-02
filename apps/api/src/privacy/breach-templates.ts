import { BRAND } from "@montaj/config";

import type { $Enums } from "@prisma/client";

/**
 * The two documents `docs/runbooks/breach-first-hour.md`'s "Afterwards" step
 * and the DPDP 72-hour Board-notification clock need, rendered from plain
 * string templates — **no LLM**, so the wording of a breach notice is never
 * something a model could hallucinate under incident pressure. Filled in by
 * `BreachIncidentsService`; an incident lead edits the output by hand before
 * it goes out, same as every other `packages/prompts`-style template in this
 * codebase is a starting draft, not a final send.
 */

export interface BreachTemplateInput {
  readonly id: string;
  readonly detectedAt: Date;
  readonly scope: unknown;
  readonly affectedCount: number;
  readonly status: $Enums.BreachStatus;
}

/** Hours remaining on the 72-hour Data Protection Board notification clock. */
export function boardNoticeHoursRemaining(detectedAt: Date, now: Date = new Date()): number {
  const elapsedHours = (now.getTime() - detectedAt.getTime()) / (60 * 60 * 1_000);
  return Math.round((72 - elapsedHours) * 10) / 10;
}

/** The Board of India notification draft (DPDP, 72-hour clock). */
export function renderBoardReport(input: BreachTemplateInput): string {
  return [
    `Data breach notification — ${BRAND.name} (${input.id})`,
    "",
    `Detected: ${input.detectedAt.toISOString()}`,
    `Status: ${input.status}`,
    `Estimated data principals affected: ${String(input.affectedCount)}`,
    `Scope: ${JSON.stringify(input.scope, null, 2)}`,
    "",
    "Nature of the breach: [incident lead to complete — what happened, how it was discovered]",
    "Categories of personal data involved: [incident lead to complete]",
    "Measures taken to mitigate: [incident lead to complete]",
    "Measures taken or proposed to address the breach: [incident lead to complete]",
    "",
    `Filed under DPDP Rule (72-hour Board notification). Draft generated ${new Date().toISOString()}; a human must review and complete every bracketed section before filing.`,
  ].join("\n");
}

/** The plain-language notice to affected users. */
export function renderUserNotice(input: BreachTemplateInput): string {
  return [
    `Subject: Important notice about your ${BRAND.name} account`,
    "",
    "We are writing to let you know about a data security incident that may have affected your account.",
    "",
    `What happened: [incident lead to complete, in plain language — no jargon]`,
    `When: we detected this on ${input.detectedAt.toISOString().slice(0, 10)}.`,
    "What information was involved: [incident lead to complete]",
    "What we are doing: [incident lead to complete]",
    "What you can do: [incident lead to complete — e.g. reset your password, review recent activity]",
    "",
    `If you have questions, contact us at ${BRAND.supportEmail}.`,
    "",
    `Draft generated ${new Date().toISOString()}; a human must review and complete every bracketed section before sending.`,
  ].join("\n");
}
