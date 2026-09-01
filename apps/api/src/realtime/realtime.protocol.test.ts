import { describe, expect, it } from "vitest";

import {
  ClientFrameSchema,
  HEARTBEAT_INTERVAL_MS,
  MAX_ROOMS_PER_CONNECTION,
  REALTIME_EVENTS,
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  parseRoom,
  projectRoom,
  roomChannel,
  roomFromChannel,
  workspaceRoom,
} from "./realtime.protocol.js";

// A real ULID: Crockford base32 excludes I, L, O and U, so "PROJECT" cannot
// appear literally — the O is a zero.
const ULID = "01JCPR0JECT000000000000000";

describe("rooms (CONTRACTS §7)", () => {
  it("names rooms exactly as the contract does", () => {
    expect(projectRoom(ULID)).toBe(`project:${ULID}`);
    expect(workspaceRoom(ULID)).toBe(`workspace:${ULID}`);
  });

  it("parses the two room kinds", () => {
    expect(parseRoom(`project:${ULID}`)).toEqual({ kind: "project", id: ULID });
    expect(parseRoom(`workspace:${ULID}`)).toEqual({ kind: "workspace", id: ULID });
  });

  it("refuses anything that is not a room this server serves", () => {
    for (const room of [
      "",
      ULID,
      "bridge:01JCPR0JECT000000000000000",
      `admin:${ULID}`,
      "project:",
      "project:not-a-ulid",
      // Lower case and the excluded Crockford letters I, L, O, U are not ULIDs.
      "project:01jcpr0ject000000000000000",
      "project:01JCPR0JECTIIIIIIIIIIIIIII",
      "project:01JCPR0JECTOOOOOOOOOOOOOOO",
      `project:${ULID}extra`,
    ]) {
      expect(parseRoom(room), room).toBeUndefined();
    }
  });
});

describe("channels", () => {
  it("round-trips a room through its Redis channel", () => {
    const channel = roomChannel("a08", `project:${ULID}`);
    expect(channel).toBe(`a08:realtime:project:${ULID}`);
    expect(roomFromChannel("a08", channel)).toBe(`project:${ULID}`);
  });

  it("ignores a channel belonging to another prefix or another subsystem", () => {
    expect(roomFromChannel("a08", `bull:realtime:project:${ULID}`)).toBeUndefined();
    expect(roomFromChannel("a08", "a08:bull:ai.transcribe:events")).toBeUndefined();
  });
});

describe("client frames", () => {
  it("accepts the three verbs", () => {
    expect(ClientFrameSchema.safeParse({ t: "ping" }).success).toBe(true);
    expect(ClientFrameSchema.safeParse({ t: "subscribe", rooms: ["workspace:x"] }).success).toBe(
      true,
    );
    expect(ClientFrameSchema.safeParse({ t: "unsubscribe", rooms: ["workspace:x"] }).success).toBe(
      true,
    );
  });

  it("rejects unknown verbs and unbounded room lists", () => {
    expect(ClientFrameSchema.safeParse({ t: "shutdown" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ t: "subscribe" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ t: "subscribe", rooms: [] }).success).toBe(false);
    expect(
      ClientFrameSchema.safeParse({
        t: "subscribe",
        rooms: Array.from({ length: 33 }, () => "workspace:x"),
      }).success,
    ).toBe(false);
    expect(
      ClientFrameSchema.safeParse({ t: "subscribe", rooms: ["x".repeat(65)] }).success,
    ).toBe(false);
  });
});

describe("constants", () => {
  it("are the ones the README documents", () => {
    expect(REALTIME_PATH).toBe("/realtime");
    expect(REALTIME_SUBPROTOCOL).toBe("aksharo.v1");
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(MAX_ROOMS_PER_CONNECTION).toBe(64);
  });

  it("carry the four events of CONTRACTS §7 and no others", () => {
    expect([...REALTIME_EVENTS].sort()).toEqual([
      "comment.added",
      "edg.ops",
      "job.completed",
      "job.progress",
    ]);
  });

  it("never puts the codename in a client-visible string (CONTRACTS §0)", () => {
    expect(REALTIME_SUBPROTOCOL).not.toContain("montaj");
    expect(REALTIME_PATH).not.toContain("montaj");
  });
});
