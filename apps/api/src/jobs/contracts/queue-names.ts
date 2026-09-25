/**
 * The queue table of `docs/CONTRACTS.md` §3, verbatim and in contract order.
 *
 * This is the canonical TypeScript copy the workers written before A08
 * (`apps/worker-media/src/queues.ts`, `apps/render/src/queues.ts`) and the Python
 * worker (`apps/worker-ai/worker_ai/queues.py`) all have to agree with. A typo is
 * not a compile error anywhere — it is a queue nothing ever reads — so
 * `queue-names.test.ts` pins the list.
 *
 * `montaj` inside a queue name is the engineering codename and is correct: the
 * brand rule (CONTRACTS §0) covers user-visible strings only.
 */
export const QUEUE_NAMES = [
  "media.probe",
  "media.proxy",
  "media.acquire",
  "media.clip",
  "ai.vad",
  "ai.transcribe",
  "ai.align",
  "ai.diarise",
  "ai.translate",
  "ai.transliterate",
  "ai.clean",
  "ai.pass",
  "ai.llm",
  "ai.highlights",
  "ai.faces",
  "render.video",
  "render.subtitle",
  "publish.dispatch",
  "publish.reconcile",
  "notify",
] as const;

/**
 * A queue name, which is also a job `type`.
 *
 * `jobs.type` is deliberately a free string in the schema because "the closed set
 * is the queue table in CONTRACTS §3 and A08 owns it" — this is that closed set.
 */
export type QueueName = (typeof QUEUE_NAMES)[number];

const QUEUE_NAME_SET: ReadonlySet<string> = new Set<string>(QUEUE_NAMES);

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === "string" && QUEUE_NAME_SET.has(value);
}

/**
 * The queue a job `type` runs on. They are the same string today; the indirection
 * exists so a later split (say `ai.transcribe.long`) is one edit here rather than
 * a change to every producer.
 */
export function queueForJobType(type: QueueName): QueueName {
  return type;
}
