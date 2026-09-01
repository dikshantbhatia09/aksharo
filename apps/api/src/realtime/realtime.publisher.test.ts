import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRealtimeBroker, InMemoryRealtimeBus } from "./realtime.bus.js";
import { roomChannel } from "./realtime.protocol.js";
import { RealtimePublisher } from "./realtime.publisher.js";
import { queuePrefix } from "../jobs/jobs.config.js";

import type { RealtimeBus } from "./realtime.bus.js";
import type { RoomMessage } from "./realtime.protocol.js";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";

/** The publisher reads the prefix from the environment, so the test must too. */
const channel = (room: string): string => roomChannel(queuePrefix(), room);

let bus: InMemoryRealtimeBus;
let publisher: RealtimePublisher;
let received: { channel: string; message: RoomMessage }[];

beforeEach(async () => {
  const broker = new InMemoryRealtimeBroker();
  bus = new InMemoryRealtimeBus(broker);
  const listener = new InMemoryRealtimeBus(broker);
  received = [];
  listener.onMessage((channel, payload) => {
    received.push({ channel, message: JSON.parse(payload) as RoomMessage });
  });
  for (const room of [`workspace:${WS}`, `project:${PROJECT}`]) {
    await listener.subscribe(channel(room));
  }
  publisher = new RealtimePublisher(bus);
});

describe("job events", () => {
  it("reaches both the workspace room and the project room", async () => {
    await publisher.jobProgress(
      { workspaceId: WS, projectId: PROJECT },
      { jobId: "job-1", progress: 40, etaMs: 1_000 },
    );

    expect(received.map((entry) => entry.channel)).toEqual([
      channel(`workspace:${WS}`),
      channel(`project:${PROJECT}`),
    ]);
    expect(received[0]?.message).toMatchObject({
      event: "job.progress",
      data: { jobId: "job-1", progress: 40, etaMs: 1_000 },
    });
    expect(Date.parse(received[0]?.message.at ?? "")).not.toBeNaN();
  });

  it("publishes only to the workspace room when the job has no project", async () => {
    await publisher.jobCompleted(
      { workspaceId: WS, projectId: null },
      {
        jobId: "job-1",
        status: "succeeded",
      },
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.channel).toBe(channel(`workspace:${WS}`));
  });

  it("carries the completion status and error through unchanged", async () => {
    await publisher.jobCompleted(
      { workspaceId: WS, projectId: PROJECT },
      { jobId: "job-1", status: "failed", error: { code: "provider/timeout", message: "gone" } },
    );
    expect(received[0]?.message.data).toEqual({
      jobId: "job-1",
      status: "failed",
      error: { code: "provider/timeout", message: "gone" },
    });
  });
});

describe("the events other work packages emit", () => {
  it("publishes edg.ops to the project room", async () => {
    await publisher.edgOps(PROJECT, {
      revision: 7,
      ops: [{ op: "SetSegmentText" }],
      source: "web",
    });
    expect(received[0]).toMatchObject({
      channel: channel(`project:${PROJECT}`),
      message: { event: "edg.ops", data: { revision: 7, source: "web" } },
    });
  });

  it("publishes comment.added to the project room", async () => {
    await publisher.commentAdded({
      commentId: "01JCCOMMENT000000000000000",
      projectId: PROJECT,
      authorId: "01JCUSER00000000000000000A",
      at: "2026-09-02T12:00:00.000Z",
    });
    expect(received[0]?.message.event).toBe("comment.added");
  });
});

describe("failure handling", () => {
  it("never throws: realtime is a courtesy, not the source of truth", async () => {
    const broken = {
      publish: vi.fn(async () => {
        throw new Error("redis is down");
      }),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onMessage: vi.fn(),
      close: vi.fn(async () => undefined),
    } satisfies RealtimeBus;

    await expect(
      new RealtimePublisher(broken).jobProgress({ workspaceId: WS }, { jobId: "j", progress: 1 }),
    ).resolves.toBeUndefined();
    expect(broken.publish).toHaveBeenCalled();
  });
});
