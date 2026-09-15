import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { QUEUE_NAMES, isQueueName, queueForJobType } from "./queue-names.js";

// Vitest runs with `apps/api` as cwd.
const APPS = resolve(process.cwd(), "..");

/** The queue table of CONTRACTS §3, typed out here so a drift is a test failure. */
const CONTRACT_QUEUES = [
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
  "render.video",
  "render.subtitle",
  "publish.dispatch",
  "publish.reconcile",
  "notify",
];

/** Names inside a `[...]`/`(...)` literal of quoted strings. */
function quotedStrings(source: string, start: RegExp): string[] {
  const match = start.exec(source);
  if (match === null) throw new Error(`could not find the queue list (${String(start)})`);
  const tail = source.slice(match.index + match[0].length);
  const end = tail.search(/[\])]/);
  const block = tail.slice(0, end);
  return [...block.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1] as string);
}

describe("QUEUE_NAMES (CONTRACTS §3)", () => {
  it("is the contract list, in contract order", () => {
    expect([...QUEUE_NAMES]).toEqual(CONTRACT_QUEUES);
  });

  it("has no duplicates", () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });

  it("matches the Node media worker's copy byte for byte", () => {
    const source = readFileSync(resolve(APPS, "worker-media/src/queues.ts"), "utf8");
    expect(quotedStrings(source, /export const QUEUE_NAMES = \[/)).toEqual(CONTRACT_QUEUES);
  });

  it("matches the Python AI worker's copy byte for byte", () => {
    const source = readFileSync(resolve(APPS, "worker-ai/worker_ai/queues.py"), "utf8");
    expect(quotedStrings(source, /QUEUE_NAMES: Final\[tuple\[str, \.\.\.\]\] = \(/)).toEqual(
      CONTRACT_QUEUES,
    );
  });
});

describe("isQueueName", () => {
  it("accepts every contract queue", () => {
    for (const name of CONTRACT_QUEUES) expect(isQueueName(name)).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["media.thumbnail", "", "AI.TRANSCRIBE", 7, null, undefined, {}]) {
      expect(isQueueName(value)).toBe(false);
    }
  });
});

describe("queueForJobType", () => {
  it("maps a job type onto its queue", () => {
    expect(queueForJobType("ai.transcribe")).toBe("ai.transcribe");
  });
});
