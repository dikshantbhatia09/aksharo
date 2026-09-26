/**
 * Turn a refused request into the one sentence this page may show.
 *
 * Every mutation on the clips pipeline's pages goes through here, so a raw API
 * message — "This workspace already has 2 jobs in flight", "The job queue is
 * unavailable" — can never reach a person through an `onError` nobody thought
 * about (clips hardening, 2026-09-26). The sentences live in `copy.ts`, where
 * the technical-word sweep covers them.
 */
import { isApiError } from "@montaj/api-client";

import { REFUSAL_COPY, type RefusalContext } from "@/components/repurpose/copy";

export interface Refusal {
  /** The code it was mapped from, for tests and support; never rendered. */
  readonly code: string;
  readonly text: string;
  /**
   * A duplicate link's live run (`details.existingRunId` on a 409
   * `repurpose/source_already_running`), so the page can offer to open it.
   */
  readonly existingRunId?: string;
}

/** Admission refusals: the plan's lane or its credit hold is full for now. */
const BUSY_CODES: ReadonlySet<string> = new Set(["jobs/concurrency_cap", "jobs/enqueue_cap"]);

function existingRunIdOf(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const id = (details as { existingRunId?: unknown }).existingRunId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export function describeRefusal(error: unknown, context: RefusalContext): Refusal {
  // eslint-disable-next-line security/detect-object-injection -- `context` is one of four literal keys
  const copy: Readonly<Record<string, string>> = REFUSAL_COPY[context];
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return { code: "network", text: copy["network"] ?? "" };
  }
  const key = BUSY_CODES.has(error.code) ? "busy" : error.code;
  // eslint-disable-next-line security/detect-object-injection -- a miss falls back to the context's own sentence
  const text = copy[key] ?? copy["fallback"] ?? "";
  const existingRunId =
    error.code === "repurpose/source_already_running" ? existingRunIdOf(error.details) : undefined;
  return {
    code: error.code,
    text,
    ...(existingRunId === undefined ? {} : { existingRunId }),
  };
}
