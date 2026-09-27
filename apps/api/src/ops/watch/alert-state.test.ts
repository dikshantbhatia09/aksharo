import { describe, expect, it } from "vitest";

import {
  AlertStateStore,
  CLEAR_AFTER_MS,
  EVENT_MEMORY_MS,
  REPEAT_MS,
  alertKey,
  formatDuration,
  parseRecord,
  planAlerts,
} from "./alert-state.js";

import type { AlertRecord, CheckResult, Finding } from "./alert-state.js";
import type { RedisService } from "../../common/redis/redis.service.js";

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const MIN = 60_000;
const DISK_KEY = alertKey("disk.low", "C:\\");

function disk(
  severity: Finding["severity"] = "warning",
  line = "C:\\ 60.0 GiB free of 476.0 GiB (12.6%)",
): Finding {
  return { check: "disk.low", subject: "C:\\", severity, line };
}

function queued(queue: string, count = 1): Finding {
  return {
    check: "jobs.queued-too-long",
    subject: queue,
    severity: "warning",
    line: `${queue}: ${String(count)} jobs queued over 15 min`,
  };
}

function ok(check: CheckResult["check"], findings: Finding[] = []): CheckResult {
  return { check, ok: true, findings };
}

type Plan = ReturnType<typeof planAlerts>;

/** Apply a plan as the watch does when every notification is delivered. */
function deliver(state: ReadonlyMap<string, AlertRecord>, plan: Plan): Map<string, AlertRecord> {
  const next = new Map(state);
  for (const planned of plan.alerts) {
    for (const [key, record] of planned.put) next.set(key, record);
    for (const key of planned.remove) next.delete(key);
  }
  for (const [key, record] of plan.put) next.set(key, record);
  for (const key of plan.remove) next.delete(key);
  return next;
}

/** Apply a plan as the watch does when the webhook takes none of it. */
function undelivered(
  state: ReadonlyMap<string, AlertRecord>,
  plan: Plan,
): Map<string, AlertRecord> {
  const next = new Map(state);
  for (const planned of plan.alerts) {
    for (const [key, record] of planned.ifUnsent) next.set(key, record);
  }
  for (const [key, record] of plan.put) next.set(key, record);
  for (const key of plan.remove) next.delete(key);
  return next;
}

/**
 * Run passes, delivering everything, and return the notifications each one sent
 * and the state after the last.
 */
function passes(
  steps: ReadonlyArray<{ readonly at: number; readonly results: readonly CheckResult[] }>,
  initial: ReadonlyMap<string, AlertRecord> = new Map(),
): { sent: Plan["alerts"][]; state: Map<string, AlertRecord> } {
  let state = new Map(initial);
  const sent: Plan["alerts"][] = [];
  for (const step of steps) {
    const plan = planAlerts({ now: step.at, results: step.results, state });
    sent.push(plan.alerts);
    state = deliver(state, plan);
  }
  return { sent, state };
}

/** A disk condition announced at T0 + 1 min (seen first at T0). */
function openDisk(severity: Finding["severity"] = "warning"): Map<string, AlertRecord> {
  return passes([
    { at: T0, results: [ok("disk.low", [disk(severity)])] },
    { at: T0 + MIN, results: [ok("disk.low", [disk(severity)])] },
  ]).state;
}

describe("planAlerts: a condition starting", () => {
  it("waits for a second pass before announcing, then stays quiet while it lasts", () => {
    const first = planAlerts({ now: T0, results: [ok("disk.low", [disk()])], state: new Map() });
    expect(first.alerts).toEqual([]);
    expect(first.put).toEqual([
      [
        DISK_KEY,
        expect.objectContaining({ pending: true, firstSeenAt: T0, lastSentAt: 0 }) as unknown,
      ],
    ]);

    const second = planAlerts({
      now: T0 + MIN,
      results: [ok("disk.low", [disk()])],
      state: deliver(new Map(), first),
    });
    expect(second.alerts).toHaveLength(1);
    expect(second.alerts[0]?.alert).toMatchObject({
      title: "Aksharo ops: disk space low",
      priority: 4,
      tags: ["floppy_disk", "disk.low"],
      body: "new: C:\\ 60.0 GiB free of 476.0 GiB (12.6%)",
    });
    // Announced: no longer pending, and dated from when it was first seen.
    expect(second.alerts[0]?.put).toEqual([
      [
        DISK_KEY,
        {
          check: "disk.low",
          kind: "condition",
          severity: "warning",
          line: "C:\\ 60.0 GiB free of 476.0 GiB (12.6%)",
          firstSeenAt: T0,
          lastSentAt: T0 + MIN,
        },
      ],
    ]);

    const { sent } = passes(
      [{ at: T0 + 2 * MIN, results: [ok("disk.low", [disk()])] }],
      deliver(deliver(new Map(), first), second),
    );
    expect(sent).toEqual([[]]);
  });

  it("never announces something seen on one pass only, such as a worker between stop and start", () => {
    const { sent, state } = passes([
      {
        at: T0,
        results: [
          ok("queues.no-worker", [
            {
              check: "queues.no-worker",
              subject: "media.probe",
              severity: "critical",
              line: "media.probe: no worker connected, 2 open jobs waiting",
            },
          ]),
        ],
      },
      { at: T0 + MIN, results: [ok("queues.no-worker")] },
    ]);

    expect(sent.flat()).toEqual([]);
    expect(state.size).toBe(0);
  });

  it("keeps a pending subject while its check cannot look, and announces it when it can again", () => {
    const { sent } = passes([
      { at: T0, results: [ok("disk.low", [disk()])] },
      { at: T0 + MIN, results: [{ check: "disk.low", ok: false, findings: [] }] },
      { at: T0 + 2 * MIN, results: [ok("disk.low", [disk()])] },
    ]);

    expect(sent.map((alerts) => alerts.length)).toEqual([0, 0, 1]);
  });
});

describe("planAlerts: a condition that lasts", () => {
  it("repeats at most every six hours", () => {
    const state = openDisk();
    const announcedAt = T0 + MIN;

    expect(
      planAlerts({
        now: announcedAt + REPEAT_MS - 1,
        results: [ok("disk.low", [disk()])],
        state,
      }).alerts,
    ).toEqual([]);
    const reminder = planAlerts({
      now: announcedAt + REPEAT_MS,
      results: [ok("disk.low", [disk()])],
      state,
    });
    expect(reminder.alerts).toHaveLength(1);
    expect(reminder.alerts[0]?.alert.body).toMatch(/^still, for 6 h 1 min: C:\\/);
    // The reminder restarts the clock and keeps when it began.
    expect(reminder.alerts[0]?.put[0]?.[1]).toMatchObject({
      firstSeenAt: T0,
      lastSentAt: announcedAt + REPEAT_MS,
    });
  });

  it("escalates at once when a problem gets worse, however recently it was sent", () => {
    const worse = planAlerts({
      now: T0 + 2 * MIN,
      results: [ok("disk.low", [disk("critical", "C:\\ 4.1 GiB free of 476.0 GiB (0.9%)")])],
      state: openDisk("warning"),
    });

    expect(worse.alerts).toHaveLength(1);
    expect(worse.alerts[0]?.alert.priority).toBe(5);
    expect(worse.alerts[0]?.alert.body).toBe("worse: C:\\ 4.1 GiB free of 476.0 GiB (0.9%)");
  });

  it("pages once for a problem swinging between two levels, then only on the six-hour reminder", () => {
    // A disk hovering on the 5 GiB line while downloads write and delete temp files.
    const steps = Array.from({ length: 60 }, (_, index) => ({
      at: T0 + (index + 2) * MIN,
      results: [ok("disk.low", [disk(index % 2 === 0 ? "critical" : "warning")])],
    }));

    const { sent, state } = passes(steps, openDisk("warning"));

    const bodies = sent.flat().map((planned) => planned.alert.body);
    expect(bodies).toEqual(["worse: C:\\ 60.0 GiB free of 476.0 GiB (12.6%)"]);
    // Remembered at the worst level announced, whatever it read last.
    expect(state.get(DISK_KEY)?.severity).toBe("critical");
  });

  it("reminds at the level it is at now, without lowering what was announced", () => {
    let state = openDisk("critical");

    const reminder = planAlerts({
      now: T0 + MIN + REPEAT_MS,
      results: [ok("disk.low", [disk("warning")])],
      state,
    });
    expect(reminder.alerts[0]?.alert.priority).toBe(4);
    state = deliver(state, reminder);
    expect(state.get(DISK_KEY)?.severity).toBe("critical");

    // So dipping back to critical straight after the reminder is not a new page.
    expect(
      planAlerts({
        now: T0 + 2 * MIN + REPEAT_MS,
        results: [ok("disk.low", [disk("critical")])],
        state,
      }).alerts,
    ).toEqual([]);
  });

  it("groups one check's subjects into one notification, and mentions the ones already reported", () => {
    const state = passes([
      {
        at: T0,
        results: [ok("jobs.queued-too-long", [queued("media.acquire"), queued("ai.faces")])],
      },
      {
        at: T0 + MIN,
        results: [ok("jobs.queued-too-long", [queued("media.acquire"), queued("ai.faces")])],
      },
      {
        at: T0 + 2 * MIN,
        results: [
          ok("jobs.queued-too-long", [
            queued("media.acquire"),
            queued("ai.faces"),
            queued("ai.transcribe"),
          ]),
        ],
      },
    ]).state;

    const plan = planAlerts({
      now: T0 + 3 * MIN,
      results: [
        ok("jobs.queued-too-long", [
          queued("media.acquire", 4),
          queued("ai.faces"),
          queued("ai.transcribe"),
        ]),
      ],
      state,
    });
    expect(plan.alerts).toHaveLength(1);
    expect(plan.alerts[0]?.alert.title).toBe("Aksharo ops: jobs queued over 15 min on 3 queues");
    expect(plan.alerts[0]?.alert.body).toBe(
      "new: ai.transcribe: 1 jobs queued over 15 min\n(2 more still open, reported earlier)",
    );
  });

  it("caps the lines in one notification", () => {
    const many = Array.from({ length: 40 }, (_, index) => queued(`queue.${String(index)}`));
    const plan = planAlerts({
      now: T0 + MIN,
      results: [ok("jobs.queued-too-long", many)],
      state: deliver(
        new Map(),
        planAlerts({ now: T0, results: [ok("jobs.queued-too-long", many)], state: new Map() }),
      ),
    });
    const lines = plan.alerts[0]?.alert.body.split("\n") ?? [];
    expect(lines).toHaveLength(16);
    expect(lines.at(-1)).toBe("... and 25 more");
    // All forty are remembered, so none is announced again next pass.
    expect(plan.alerts[0]?.put).toHaveLength(40);
  });
});

describe("planAlerts: a condition ending", () => {
  it("sends one 'cleared' once it has stayed gone for the grace period, then forgets it", () => {
    const state = openDisk();
    const goneAt = T0 + 90 * MIN;

    const gone = planAlerts({ now: goneAt, results: [ok("disk.low")], state });
    expect(gone.alerts).toEqual([]);
    const waiting = deliver(state, gone);
    expect(waiting.get(DISK_KEY)?.goneSince).toBe(goneAt);

    expect(
      planAlerts({ now: goneAt + CLEAR_AFTER_MS - 1, results: [ok("disk.low")], state: waiting })
        .alerts,
    ).toEqual([]);

    const cleared = planAlerts({
      now: goneAt + CLEAR_AFTER_MS,
      results: [ok("disk.low")],
      state: waiting,
    });
    expect(cleared.alerts).toHaveLength(1);
    expect(cleared.alerts[0]?.alert).toMatchObject({
      title: "Aksharo ops: cleared - disk space low",
      priority: 3,
      tags: ["white_check_mark", "disk.low"],
      // How long it lasted: to when it went, not to the end of the wait.
      body: "cleared after 1 h 30 min: C:\\ 60.0 GiB free of 476.0 GiB (12.6%)",
    });

    const after = deliver(waiting, cleared);
    expect(after.size).toBe(0);
    expect(
      planAlerts({ now: goneAt + CLEAR_AFTER_MS + MIN, results: [ok("disk.low")], state: after })
        .alerts,
    ).toEqual([]);
  });

  it("carries on silently when it comes back within the grace period", () => {
    const steps = [
      // A disk hovering on the 15 % line: gone, back, gone, back, gone ...
      ...Array.from({ length: 20 }, (_, index) => ({
        at: T0 + (index + 2) * MIN,
        results: [ok("disk.low", index % 3 === 0 ? [disk()] : [])],
      })),
    ];

    const { sent, state } = passes(steps, openDisk());

    expect(sent.flat()).toEqual([]);
    expect(state.get(DISK_KEY)?.pending).toBeUndefined();
    // The last pass (T0 + 21 min) saw it gone, the one before saw it back: the
    // grace period counts from the latest absence, not from the first.
    expect(state.get(DISK_KEY)?.goneSince).toBe(T0 + 21 * MIN);
  });

  it("drops the grace period when it comes back, so the next absence starts a new one", () => {
    const { state } = passes(
      [
        { at: T0 + 2 * MIN, results: [ok("disk.low")] },
        { at: T0 + 3 * MIN, results: [ok("disk.low", [disk()])] },
      ],
      openDisk(),
    );

    expect(state.get(DISK_KEY)).not.toHaveProperty("goneSince");
  });

  it("does not call a problem gone when its check could not run", () => {
    const blind = planAlerts({
      now: T0 + 2 * MIN,
      results: [{ check: "disk.low", ok: false, findings: [] }],
      state: openDisk(),
    });
    expect(blind).toEqual({ alerts: [], put: [], remove: [] });
  });

  it("does not call a problem gone when its check saw only part of what it covers", () => {
    const state = passes([
      { at: T0, results: [ok("jobs.over-ceiling", [queued("x")].map(overCeiling))] },
      { at: T0 + MIN, results: [ok("jobs.over-ceiling", [queued("x")].map(overCeiling))] },
    ]).state;

    const plan = planAlerts({
      now: T0 + 2 * MIN,
      results: [{ check: "jobs.over-ceiling", ok: true, partial: true, findings: [] }],
      state,
    });
    expect(plan).toEqual({ alerts: [], put: [], remove: [] });
  });

  it("drops a stored record for a check that no longer exists, without a notification", () => {
    const state = new Map<string, AlertRecord>([
      [
        "gone.check|x",
        {
          check: "gone.check",
          kind: "condition",
          severity: "warning",
          line: "x",
          firstSeenAt: T0,
          lastSentAt: T0,
        },
      ],
    ]);
    const plan = planAlerts({ now: T0 + MIN, results: [], state });
    expect(plan.alerts).toEqual([]);
    expect(plan.remove).toEqual(["gone.check|x"]);
  });
});

function overCeiling(finding: Finding): Finding {
  return { ...finding, check: "jobs.over-ceiling" };
}

describe("planAlerts: events", () => {
  const dead = (id: string): Finding => ({
    check: "dlq.new",
    subject: id,
    severity: "notice",
    line: `media.acquire job ${id}J: media/source_blocked`,
  });

  it("announces each event once, at once, however many passes still see it", () => {
    const first = planAlerts({
      now: T0,
      results: [ok("dlq.new", [dead("01D1")])],
      state: new Map(),
    });
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]?.alert).toMatchObject({
      title: "Aksharo ops: 1 new dead letter",
      priority: 3,
    });

    const state = deliver(new Map(), first);
    const again = planAlerts({
      now: T0 + MIN,
      results: [ok("dlq.new", [dead("01D1"), dead("01D2")])],
      state,
    });
    expect(again.alerts).toHaveLength(1);
    expect(again.alerts[0]?.alert.body).toBe("media.acquire job 01D2J: media/source_blocked");
  });

  it("never sends 'cleared' for an event, and forgets it after a day", () => {
    const state = deliver(
      new Map(),
      planAlerts({ now: T0, results: [ok("dlq.new", [dead("01D1")])], state: new Map() }),
    );

    expect(planAlerts({ now: T0 + MIN, results: [ok("dlq.new")], state }).alerts).toEqual([]);
    const later = planAlerts({ now: T0 + EVENT_MEMORY_MS, results: [ok("dlq.new")], state });
    expect(later.alerts).toEqual([]);
    expect(later.remove).toEqual([alertKey("dlq.new", "01D1")]);
  });

  it("keeps an undelivered event as owed, and sends it after its check has stopped seeing it", () => {
    // The webhook is down for longer than the checks look back.
    let state = undelivered(
      new Map(),
      planAlerts({ now: T0, results: [ok("dlq.new", [dead("01D1")])], state: new Map() }),
    );
    expect(state.get(alertKey("dlq.new", "01D1"))).toMatchObject({ unsent: true, lastSentAt: 0 });

    const later = planAlerts({ now: T0 + 60 * MIN, results: [ok("dlq.new")], state });
    expect(later.alerts).toHaveLength(1);
    expect(later.alerts[0]?.alert.body).toBe("media.acquire job 01D1J: media/source_blocked");

    state = deliver(state, later);
    expect(state.get(alertKey("dlq.new", "01D1"))).toEqual({
      check: "dlq.new",
      kind: "event",
      severity: "notice",
      line: "media.acquire job 01D1J: media/source_blocked",
      firstSeenAt: T0,
      lastSentAt: T0 + 60 * MIN,
    });
    expect(planAlerts({ now: T0 + 61 * MIN, results: [ok("dlq.new")], state }).alerts).toEqual([]);
  });

  it("gives up on an owed event after a day; the API log has it", () => {
    const state = undelivered(
      new Map(),
      planAlerts({ now: T0, results: [ok("dlq.new", [dead("01D1")])], state: new Map() }),
    );

    const plan = planAlerts({ now: T0 + EVENT_MEMORY_MS, results: [ok("dlq.new")], state });
    expect(plan.alerts).toEqual([]);
    expect(plan.remove).toEqual([alertKey("dlq.new", "01D1")]);
  });

  it("sends a failed clips run quietly", () => {
    const plan = planAlerts({
      now: T0,
      results: [
        ok("repurpose.run-failed", [
          {
            check: "repurpose.run-failed",
            subject: "01R:repurpose/source_blocked",
            severity: "info",
            line: "run 01R: repurpose/source_blocked",
          },
        ]),
      ],
      state: new Map(),
    });
    expect(plan.alerts[0]?.alert).toMatchObject({
      title: "Aksharo ops: 1 clips run failed",
      priority: 2,
    });
  });
});

describe("AlertStateStore", () => {
  function fakeRedis() {
    const hashes = new Map<string, Map<string, string>>();
    const client = {
      hgetall: async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map()),
      hset: async (key: string, values: Record<string, string>) => {
        const hash = hashes.get(key) ?? new Map<string, string>();
        for (const [field, value] of Object.entries(values)) hash.set(field, value);
        hashes.set(key, hash);
        return Object.keys(values).length;
      },
      hdel: async (key: string, ...fields: string[]) => {
        for (const field of fields) hashes.get(key)?.delete(field);
        return fields.length;
      },
    };
    return { hashes, service: { client } as unknown as RedisService };
  }

  it("round-trips records through one hash and skips what it cannot read", async () => {
    const { hashes, service } = fakeRedis();
    const store = new AlertStateStore(service);
    const record: AlertRecord = {
      check: "disk.low",
      kind: "condition",
      severity: "critical",
      line: "C:\\ 1.0 GiB free",
      firstSeenAt: T0,
      lastSentAt: T0,
      goneSince: T0 + MIN,
    };

    await store.put([["disk.low|C:\\", record]]);
    const [key] = [...hashes.keys()];
    expect(key).toMatch(/:ops:watch:alerts$/);
    hashes.get(key ?? "")?.set("junk|1", "{not json");

    expect([...(await store.load())]).toEqual([["disk.low|C:\\", record]]);

    await store.remove(["disk.low|C:\\"]);
    expect((await store.load()).size).toBe(0);
  });
});

describe("parseRecord", () => {
  const valid = {
    check: "disk.low",
    kind: "condition",
    severity: "info",
    line: "",
    firstSeenAt: 1,
    lastSentAt: 1,
  };

  it("reads the optional markers a pass writes", () => {
    const record = { ...valid, pending: true, goneSince: 5, unsent: false };
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
  });

  it("refuses a record with an unknown severity, missing times or a malformed marker", () => {
    expect(parseRecord(JSON.stringify({ ...valid, severity: "doom" }))).toBeNull();
    expect(
      parseRecord(
        JSON.stringify({ check: "disk.low", kind: "condition", severity: "info", line: "" }),
      ),
    ).toBeNull();
    expect(parseRecord(JSON.stringify({ ...valid, pending: "yes" }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...valid, goneSince: "soon" }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...valid, unsent: 1 }))).toBeNull();
  });
});

describe("formatDuration", () => {
  it("reads like a person wrote it", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(12 * MIN)).toBe("12 min");
    expect(formatDuration(130 * MIN)).toBe("2 h 10 min");
    expect(formatDuration(120 * MIN)).toBe("2 h");
    expect(formatDuration((3 * 24 + 4) * 60 * MIN)).toBe("3 d 4 h");
  });
});
