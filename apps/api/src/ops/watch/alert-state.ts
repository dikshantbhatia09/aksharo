import { Injectable } from "@nestjs/common";

import { BRAND } from "@montaj/config";

import { RedisService } from "../../common/redis/redis.service.js";
import { queuePrefix } from "../../jobs/jobs.config.js";

import type { AlertPriority, OpsAlert } from "./alert-sender.js";

/**
 * What the watch checks, and how each one is worded.
 *
 * A **condition** is a state that holds until it does not: a disk that is full,
 * a queue with no worker. It is alerted on the way in, reminded about every
 * {@link REPEAT_MS} while it lasts, and gets one "cleared" when it ends.
 * An **event** happened once — a job dead-lettered, a run failed — and is
 * alerted once.
 *
 * A title's `n` counts subjects: queues for the job checks (a backlog is one
 * alert per queue, not one per job), volumes for the disk.
 */
export const WATCH_CHECKS = {
  "jobs.over-ceiling": {
    kind: "condition",
    title: (n: number) => `jobs past the stage ceiling on ${plural(n, "queue", "queues")}`,
    tag: "hourglass",
  },
  "jobs.queued-too-long": {
    kind: "condition",
    title: (n: number) => `jobs queued over 15 min on ${plural(n, "queue", "queues")}`,
    tag: "hourglass",
  },
  "queues.no-worker": {
    kind: "condition",
    title: (n: number) => `no worker on ${plural(n, "queue", "queues")}`,
    tag: "construction",
  },
  "disk.low": {
    kind: "condition",
    title: () => "disk space low",
    tag: "floppy_disk",
  },
  "dlq.new": {
    kind: "event",
    title: (n: number) => `${plural(n, "new dead letter", "new dead letters")}`,
    tag: "skull",
  },
  "repurpose.run-failed": {
    kind: "event",
    title: (n: number) => `${plural(n, "clips run", "clips runs")} failed`,
    tag: "information_source",
  },
  "watch.check-failed": {
    kind: "condition",
    title: (n: number) => `${plural(n, "ops check", "ops checks")} could not run`,
    tag: "question",
  },
} as const satisfies Record<string, { kind: CheckKind; title: (n: number) => string; tag: string }>;

export type CheckId = keyof typeof WATCH_CHECKS;
export type CheckKind = "condition" | "event";

interface CheckDefinition {
  readonly kind: CheckKind;
  readonly title: (n: number) => string;
  readonly tag: string;
}

const DEFINITIONS: ReadonlyMap<string, CheckDefinition> = new Map(Object.entries(WATCH_CHECKS));

function definitionOf(check: CheckId): CheckDefinition {
  return (
    DEFINITIONS.get(check) ?? {
      kind: "condition",
      title: (n) => `${String(n)} ${check}`,
      tag: "warning",
    }
  );
}

/** Worst first. `critical` pages loudly; `info` is a quiet line in the feed. */
export type Severity = "critical" | "warning" | "notice" | "info";

const SEVERITY_RANK: ReadonlyMap<string, number> = new Map<Severity, number>([
  ["info", 0],
  ["notice", 1],
  ["warning", 2],
  ["critical", 3],
]);

const PRIORITY_FOR: ReadonlyMap<Severity, AlertPriority> = new Map<Severity, AlertPriority>([
  ["critical", 5],
  ["warning", 4],
  ["notice", 3],
  ["info", 2],
]);

function rank(severity: Severity): number {
  return SEVERITY_RANK.get(severity) ?? 0;
}

/** A condition still bad is mentioned again this often (owner decision: at most every 6 h). */
export const REPEAT_MS = 6 * 60 * 60_000;

/**
 * How long an open condition must stay gone before "cleared" is sent. A worker
 * restarting during a deploy, or a disk hovering on a threshold while a
 * download's temp files come and go, is one problem that blinked, not a
 * "cleared" and a "new" every few minutes. Coming back inside this window
 * carries on the same episode, silently.
 */
export const CLEAR_AFTER_MS = 10 * 60_000;

/** How long an announced event is remembered, so it is never announced twice. */
export const EVENT_MEMORY_MS = 24 * 60 * 60_000;

/** Subjects listed in one notification before "and N more". */
const MAX_LINES = 15;

/** One bad thing a check found. */
export interface Finding {
  readonly check: CheckId;
  /** What it is about, stable across passes: a queue name, a volume, a dead letter's id. */
  readonly subject: string;
  readonly severity: Severity;
  /** One line for a person: ids, counts and durations only. */
  readonly line: string;
}

/**
 * A check's answer for one pass. `ok: false` means it could not look, not that
 * all is well. `partial` means it looked at only part of what it covers (a
 * capped scan): what it found is real, but what it did not find may simply be
 * past the cap, so it can open and keep alerts but never clear one.
 */
export interface CheckResult {
  readonly check: CheckId;
  readonly ok: boolean;
  readonly partial?: boolean;
  readonly findings: readonly Finding[];
}

/** What is remembered about one subject between passes. */
export interface AlertRecord {
  readonly check: string;
  readonly kind: CheckKind;
  /**
   * For an open condition, the worst level announced in this episode. It only
   * ever rises while the condition lasts, so a problem that moves back and forth
   * between two levels is announced at the higher one once, then reminded about
   * every {@link REPEAT_MS} — not paged again on every swing back up.
   */
  readonly severity: Severity;
  /** The last line sent (or seen, while pending), so "cleared" can say what cleared. */
  readonly line: string;
  readonly firstSeenAt: number;
  /** 0 while nothing has been sent. */
  readonly lastSentAt: number;
  /** A condition seen on one pass and not yet announced: it must still be there on the next. */
  readonly pending?: boolean;
  /** When an open condition was first found gone; "cleared" waits {@link CLEAR_AFTER_MS} from here. */
  readonly goneSince?: number;
  /** An event whose notification was not delivered: still owed, beyond the checks' lookback. */
  readonly unsent?: boolean;
}

export function alertKey(check: string, subject: string): string {
  return `${check}|${subject}`;
}

type Entry = readonly [string, AlertRecord];

interface OpenEntry {
  readonly key: string;
  readonly finding: Finding;
  readonly status: "new" | "worse" | "still";
  /** The stored record, when there is one: its episode start and announced level carry on. */
  readonly record?: AlertRecord;
}

interface EventEntry {
  readonly key: string;
  readonly severity: Severity;
  readonly line: string;
  readonly firstSeenAt: number;
}

/** One notification and the state to write once it is, or is not, delivered. */
export interface PlannedAlert {
  readonly alert: OpsAlert;
  readonly put: readonly Entry[];
  readonly remove: readonly string[];
  /** Written instead of `put` when delivery fails: events still owed. */
  readonly ifUnsent: readonly Entry[];
}

export interface AlertPlan {
  readonly alerts: readonly PlannedAlert[];
  /** State that changes whether or not anything is sent (a pending subject, a forgotten event). */
  readonly put: readonly Entry[];
  readonly remove: readonly string[];
}

/**
 * Decide what to send this pass. Pure: the clock, the findings and the stored
 * state in, the notifications and the state writes out. Every key is written by
 * at most one of the returned lists, so the order they are applied in does not
 * matter.
 *
 * Conditions:
 * - Seen for the first time, a condition is only remembered as **pending**; it
 *   is announced (**new**) if the next pass still finds it. One minute's blip —
 *   a worker between stop and start, a check that timed out once — never pages.
 * - One whose level rises above the worst already announced in this episode is
 *   **worse**, at once (a disk going from under 15 % to under 5 GiB must not
 *   wait six hours to be heard). Falling back does not lower the announced
 *   level, so swinging up again is not news ({@link AlertRecord.severity}).
 * - One last sent {@link REPEAT_MS} ago or more is **still**, at its current level.
 * - One its check no longer finds is **cleared** once it has stayed gone for
 *   {@link CLEAR_AFTER_MS}; back before that, it carries on as if it never left.
 *   A check that could not run, or saw only part of its ground, clears nothing:
 *   not being able to look is not the same as the problem having gone.
 *
 * Events are sent once and remembered for {@link EVENT_MEMORY_MS}; one whose
 * notification was not delivered is kept as owed and sent with the next
 * notification of its check, even after the check has stopped seeing it.
 *
 * Findings of one check go out as one notification.
 */
export function planAlerts(input: {
  readonly now: number;
  readonly results: readonly CheckResult[];
  readonly state: ReadonlyMap<string, AlertRecord>;
}): AlertPlan {
  const { now, results, state } = input;
  const alerts: PlannedAlert[] = [];
  const put: Entry[] = [];
  const remove: string[] = [];

  // The checks whose silence about a subject means it is gone.
  const complete = new Set<string>(
    results.filter((r) => r.ok && r.partial !== true).map((r) => r.check),
  );
  const current = new Map<string, Finding>();
  for (const result of results) {
    for (const finding of result.findings)
      current.set(alertKey(finding.check, finding.subject), finding);
  }

  // Conditions that are present.
  const due = new Map<CheckId, OpenEntry[]>();
  const quiet = new Map<CheckId, number>();
  const events = new Map<CheckId, EventEntry[]>();
  for (const [key, finding] of current) {
    const check = finding.check;
    const record = state.get(key);
    if (definitionOf(check).kind === "event") {
      if (record === undefined || record.unsent === true) {
        append(events, check, {
          key,
          severity: finding.severity,
          line: finding.line,
          firstSeenAt: record?.firstSeenAt ?? now,
        });
      }
      continue;
    }

    if (record === undefined) {
      put.push([key, pendingRecord(finding, now)]);
    } else if (record.pending === true) {
      append(due, check, { key, finding, status: "new", record });
    } else if (rank(finding.severity) > rank(record.severity)) {
      append(due, check, { key, finding, status: "worse", record });
    } else if (now - record.lastSentAt >= REPEAT_MS) {
      append(due, check, { key, finding, status: "still", record });
    } else {
      quiet.set(check, (quiet.get(check) ?? 0) + 1);
      if (record.goneSince !== undefined) {
        // Back within the grace period: the same episode, and nothing to say.
        put.push([key, withoutGone(record)]);
      }
    }
  }
  for (const [check, entries] of due) {
    alerts.push(openAlert(check, entries, quiet.get(check) ?? 0, now));
  }

  // Stored subjects the checks did not report this pass.
  const cleared = new Map<CheckId, Entry[]>();
  for (const [key, record] of state) {
    if (current.has(key)) continue;
    if (!DEFINITIONS.has(record.check)) {
      // A check that no longer exists cannot clear or be sent; drop it quietly.
      remove.push(key);
      continue;
    }
    const check = record.check as CheckId;

    if (record.kind === "event") {
      if (record.unsent === true) {
        // Owed. Given up on after a day: the API log already has it.
        if (now - record.firstSeenAt >= EVENT_MEMORY_MS) remove.push(key);
        else {
          append(events, check, {
            key,
            severity: record.severity,
            line: record.line,
            firstSeenAt: record.firstSeenAt,
          });
        }
      } else if (now - record.lastSentAt >= EVENT_MEMORY_MS) {
        remove.push(key);
      }
      continue;
    }

    if (!complete.has(check)) continue;
    if (record.pending === true) {
      // Seen once and gone again: never announced, so nothing to clear.
      remove.push(key);
    } else if (record.goneSince === undefined) {
      put.push([key, { ...record, goneSince: now }]);
    } else if (now - record.goneSince >= CLEAR_AFTER_MS) {
      append(cleared, check, [key, record]);
    }
  }
  for (const [check, entries] of events) alerts.push(eventAlert(check, entries, now));
  for (const [check, entries] of cleared) alerts.push(clearedAlert(check, entries));

  return { alerts, put, remove };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function pendingRecord(finding: Finding, now: number): AlertRecord {
  return {
    check: finding.check,
    kind: "condition",
    severity: finding.severity,
    line: finding.line,
    firstSeenAt: now,
    lastSentAt: 0,
    pending: true,
  };
}

function withoutGone(record: AlertRecord): AlertRecord {
  const { goneSince: _gone, ...rest } = record;
  return rest;
}

function openAlert(
  check: CheckId,
  due: readonly OpenEntry[],
  quiet: number,
  now: number,
): PlannedAlert {
  const definition = definitionOf(check);
  const worst = worstOf(due.map((entry) => entry.finding.severity));
  const lines = due.map((entry) => {
    if (entry.status === "new") return `new: ${entry.finding.line}`;
    if (entry.status === "worse") return `worse: ${entry.finding.line}`;
    const since = entry.record?.firstSeenAt ?? now;
    return `still, for ${formatDuration(now - since)}: ${entry.finding.line}`;
  });
  if (quiet > 0) lines.push(`(${String(quiet)} more still open, reported earlier)`);
  return {
    alert: {
      title: `${BRAND.name} ops: ${definition.title(due.length + quiet)}`,
      body: listBody(lines),
      priority: PRIORITY_FOR.get(worst) ?? 3,
      tags: [definition.tag, check],
    },
    put: due.map((entry) => {
      const announced =
        entry.status === "still" && entry.record !== undefined
          ? worstOf([entry.record.severity, entry.finding.severity])
          : entry.finding.severity;
      const record: AlertRecord = {
        check,
        kind: "condition",
        severity: announced,
        line: entry.finding.line,
        firstSeenAt: entry.record?.firstSeenAt ?? now,
        lastSentAt: now,
      };
      return [entry.key, record] as const;
    }),
    remove: [],
    ifUnsent: [],
  };
}

function eventAlert(check: CheckId, entries: readonly EventEntry[], now: number): PlannedAlert {
  const definition = definitionOf(check);
  const record = (entry: EventEntry, sent: boolean): Entry => [
    entry.key,
    {
      check,
      kind: "event",
      severity: entry.severity,
      line: entry.line,
      firstSeenAt: entry.firstSeenAt,
      lastSentAt: sent ? now : 0,
      ...(sent ? {} : { unsent: true }),
    },
  ];
  return {
    alert: {
      title: `${BRAND.name} ops: ${definition.title(entries.length)}`,
      body: listBody(entries.map((entry) => entry.line)),
      priority: PRIORITY_FOR.get(worstOf(entries.map((entry) => entry.severity))) ?? 3,
      tags: [definition.tag, check],
    },
    put: entries.map((entry) => record(entry, true)),
    remove: [],
    ifUnsent: entries.map((entry) => record(entry, false)),
  };
}

function clearedAlert(check: CheckId, entries: readonly Entry[]): PlannedAlert {
  const definition = definitionOf(check);
  return {
    alert: {
      title: `${BRAND.name} ops: cleared - ${definition.title(entries.length)}`,
      body: listBody(
        entries.map(([, record]) => {
          // How long it lasted: up to when it went, not up to the grace period's end.
          const endedAt = record.goneSince ?? record.lastSentAt;
          return `cleared after ${formatDuration(endedAt - record.firstSeenAt)}: ${record.line}`;
        }),
      ),
      priority: 3,
      tags: ["white_check_mark", check],
    },
    put: [],
    remove: entries.map(([key]) => key),
    ifUnsent: [],
  };
}

function worstOf(severities: readonly Severity[]): Severity {
  return severities.reduce<Severity>(
    (worst, next) => (rank(next) > rank(worst) ? next : worst),
    "info",
  );
}

function listBody(lines: readonly string[]): string {
  if (lines.length <= MAX_LINES) return lines.join("\n");
  const shown = lines.slice(0, MAX_LINES);
  return [...shown, `... and ${String(lines.length - MAX_LINES)} more`].join("\n");
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** `45 s`, `12 min`, `2 h 10 min`, `3 d 4 h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${String(days)} d` : `${String(days)} d ${String(rest)} h`;
}

/**
 * Where the watch remembers what it has said, between passes and across API
 * restarts: one Redis hash, a field per alerted subject.
 *
 * Redis rather than memory because the scheduler hands each tick to whichever
 * API instance is free, and because a restart must neither re-announce every
 * open problem nor forget to say that one cleared while the API was down.
 */
@Injectable()
export class AlertStateStore {
  private readonly key = `${queuePrefix()}:ops:watch:alerts`;

  constructor(private readonly redis: RedisService) {}

  async load(): Promise<Map<string, AlertRecord>> {
    const raw = await this.redis.client.hgetall(this.key);
    const state = new Map<string, AlertRecord>();
    for (const [field, value] of Object.entries(raw)) {
      const record = parseRecord(value);
      if (record !== null) state.set(field, record);
    }
    return state;
  }

  async put(entries: ReadonlyArray<readonly [string, AlertRecord]>): Promise<void> {
    if (entries.length === 0) return;
    await this.redis.client.hset(
      this.key,
      Object.fromEntries(entries.map(([field, record]) => [field, JSON.stringify(record)])),
    );
  }

  async remove(fields: readonly string[]): Promise<void> {
    if (fields.length === 0) return;
    await this.redis.client.hdel(this.key, ...fields);
  }
}

/** A stored record, or `null` for anything this version cannot read (it is then re-alerted, never crashed on). */
export function parseRecord(value: string): AlertRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<AlertRecord>;
    if (
      typeof parsed.check !== "string" ||
      (parsed.kind !== "condition" && parsed.kind !== "event") ||
      typeof parsed.severity !== "string" ||
      !SEVERITY_RANK.has(parsed.severity) ||
      typeof parsed.line !== "string" ||
      typeof parsed.firstSeenAt !== "number" ||
      typeof parsed.lastSentAt !== "number" ||
      (parsed.pending !== undefined && typeof parsed.pending !== "boolean") ||
      (parsed.goneSince !== undefined && typeof parsed.goneSince !== "number") ||
      (parsed.unsent !== undefined && typeof parsed.unsent !== "boolean")
    ) {
      return null;
    }
    return parsed as AlertRecord;
  } catch {
    return null;
  }
}
