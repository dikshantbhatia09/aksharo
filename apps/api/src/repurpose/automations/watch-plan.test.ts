import { describe, expect, it } from "vitest";

import {
  WATCH_CHECK_EVERY_MS,
  WATCH_CHECK_JITTER_MS,
  WATCH_CURSOR_MAX,
  WATCH_RETRY_MAX_MS,
} from "./source-watch.constants.js";
import { nextCheckAfterFailure, nextCheckAfterRead, planFeed, seenOf } from "./watch-plan.js";

import type { FeedEntry } from "./channel-feed.js";
import type { PlanInput } from "./watch-plan.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-02T12:00:00Z");
const CREATED = new Date("2026-10-01T00:00:00Z");

function entry(id: number, publishedAt: Date, extra: Partial<FeedEntry> = {}): FeedEntry {
  const videoId = `vid${String(id).padStart(8, "0")}`;
  return {
    videoId,
    title: `Video ${String(id)}`,
    publishedAt,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    isShort: false,
    views: 100,
    ...extra,
  };
}

function plan(overrides: Partial<PlanInput>) {
  return planFeed({
    now: NOW,
    since: CREATED,
    firstRead: false,
    backfill: 0,
    seen: [],
    recorded: new Set(),
    entries: [],
    ...overrides,
  });
}

describe("planFeed", () => {
  it("starts what was published after the watch was made, and only marks the back catalogue seen", () => {
    const result = plan({
      entries: [
        entry(1, new Date("2026-09-20T00:00:00Z")),
        entry(2, new Date("2026-10-01T09:00:00Z")),
        entry(3, new Date("2026-10-02T08:00:00Z")),
      ],
    });
    expect(result.videos).toEqual([
      expect.objectContaining({ videoId: "vid00000003", state: "pending", backfill: false }),
      expect.objectContaining({ videoId: "vid00000002", state: "pending", backfill: false }),
    ]);
    expect(result.seen).toEqual(["vid00000003", "vid00000002", "vid00000001"]);
    expect(result.waiting).toEqual([]);
  });

  it("on the first read only, also takes the newest N real videos of the back catalogue", () => {
    const older = [
      entry(1, new Date("2026-09-01T00:00:00Z")),
      entry(2, new Date("2026-09-10T00:00:00Z"), { isShort: true }),
      entry(3, new Date("2026-09-20T00:00:00Z")),
      entry(4, new Date("2026-09-25T00:00:00Z"), { views: 0 }),
      entry(5, new Date("2026-09-28T00:00:00Z")),
    ];
    const first = plan({ firstRead: true, backfill: 2, entries: older });
    expect(first.videos.map((video) => [video.videoId, video.state, video.backfill])).toEqual([
      ["vid00000005", "pending", true],
      ["vid00000003", "pending", true],
    ]);
    // Asked for at creation, so not "too old", even at a month.
    expect(
      plan({ firstRead: true, backfill: 1, now: new Date("2026-11-30T00:00:00Z"), entries: older })
        .videos,
    ).toHaveLength(1);
    // Not on a later read: the back catalogue stays the back catalogue.
    expect(plan({ firstRead: false, backfill: 3, entries: older }).videos).toEqual([]);
  });

  it("skips Shorts, waits on videos with no views yet, and records old news as too old", () => {
    const result = plan({
      entries: [
        entry(1, new Date("2026-10-02T10:00:00Z"), { isShort: true }),
        entry(2, new Date("2026-10-02T11:00:00Z"), { views: 0 }),
        entry(3, new Date(NOW.getTime() - 8 * DAY - HOUR)),
      ],
      since: new Date("2026-09-01T00:00:00Z"),
    });
    expect(result.videos.map((video) => [video.videoId, video.state, video.reason])).toEqual([
      ["vid00000001", "skipped", "short"],
      ["vid00000003", "skipped", "too_old"],
    ]);
    // No views: not seen, so the next read looks again.
    expect(result.waiting).toEqual(["vid00000002"]);
    expect(result.seen).not.toContain("vid00000002");
  });

  it("gives up waiting on a video with no views after a week", () => {
    const result = plan({
      since: new Date("2026-09-01T00:00:00Z"),
      entries: [entry(9, new Date(NOW.getTime() - 7 * DAY - HOUR), { views: 0 })],
    });
    expect(result.videos).toEqual([
      expect.objectContaining({ videoId: "vid00000009", state: "skipped", reason: "upcoming" }),
    ]);
  });

  it("never records the same video twice: the cursor and the rows both count", () => {
    const entries = [
      entry(1, new Date("2026-10-02T01:00:00Z")),
      entry(2, new Date("2026-10-02T02:00:00Z")),
      entry(3, new Date("2026-10-02T03:00:00Z")),
    ];
    const result = plan({ entries, seen: ["vid00000001"], recorded: new Set(["vid00000002"]) });
    expect(result.videos.map((video) => video.videoId)).toEqual(["vid00000003"]);
    expect(result.seen.slice(0, 3)).toEqual(["vid00000003", "vid00000002", "vid00000001"]);
  });

  it("keeps the cursor newest first and bounded", () => {
    const old = Array.from(
      { length: WATCH_CURSOR_MAX },
      (_, i) => `old${String(i).padStart(8, "0")}`,
    );
    const result = plan({ seen: old, entries: [entry(1, new Date("2026-10-02T01:00:00Z"))] });
    expect(result.seen).toHaveLength(WATCH_CURSOR_MAX);
    expect(result.seen[0]).toBe("vid00000001");
    expect(result.seen).not.toContain(old[WATCH_CURSOR_MAX - 1]);
  });

  it("names an untitled video by its id", () => {
    const result = plan({ entries: [entry(1, new Date("2026-10-02T01:00:00Z"), { title: "" })] });
    expect(result.videos[0]?.title).toBe("vid00000001");
  });
});

describe("the schedule", () => {
  it("reads a watch an hour after its last read, plus up to fifteen minutes, never sooner", () => {
    expect(nextCheckAfterRead(NOW, () => 0).getTime() - NOW.getTime()).toBe(WATCH_CHECK_EVERY_MS);
    expect(nextCheckAfterRead(NOW, () => 0.999999).getTime() - NOW.getTime()).toBeLessThan(
      WATCH_CHECK_EVERY_MS + WATCH_CHECK_JITTER_MS,
    );
    // A broken random source cannot pull it earlier.
    expect(nextCheckAfterRead(NOW, () => -5).getTime() - NOW.getTime()).toBe(WATCH_CHECK_EVERY_MS);
  });

  it("backs off after failed reads, doubling to a day", () => {
    const wait = (failures: number) =>
      nextCheckAfterFailure(NOW, failures, () => 0).getTime() - NOW.getTime();
    expect(wait(1)).toBe(HOUR);
    expect(wait(2)).toBe(2 * HOUR);
    expect(wait(3)).toBe(4 * HOUR);
    expect(wait(30)).toBe(WATCH_RETRY_MAX_MS);
  });
});

describe("seenOf", () => {
  it("reads a cursor back, and nothing from anything else", () => {
    expect(seenOf({ seen: ["vid00000001", 5, "bad", "vid00000002"] })).toEqual([
      "vid00000001",
      "vid00000002",
    ]);
    for (const junk of [null, "x", [], { seen: "x" }, 42]) expect(seenOf(junk)).toEqual([]);
  });
});
