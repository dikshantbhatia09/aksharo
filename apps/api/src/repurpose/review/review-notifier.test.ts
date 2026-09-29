import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import {
  IDS,
  ReviewMemory,
  recorders,
  seedClip,
  seedWorkspace,
} from "./review-memory.test-support.js";
import { ReviewNotifier, type ReviewNotice } from "./review-notifier.js";

import type { NotifyService } from "../../notify/notify.service.js";

const ENV = { WEB_ORIGIN: "https://aksharo.test", FEATURE_FLAGS_JSON: {} } as unknown as Env;

function setup(): {
  memory: ReviewMemory;
  notifier: ReviewNotifier;
  rec: ReturnType<typeof recorders>;
  clip: string;
} {
  const memory = new ReviewMemory();
  seedWorkspace(memory);
  const clip = seedClip(memory, 1);
  const rec = recorders(memory);
  const notifier = new ReviewNotifier(memory.prisma, rec.notify as unknown as NotifyService, ENV);
  return { memory, notifier, rec, clip };
}

function notice(clip: string, over: Partial<ReviewNotice> = {}): ReviewNotice {
  return {
    workspaceId: IDS.ws,
    runId: IDS.run,
    clipId: clip,
    verdict: "approved",
    actor: { kind: "client", name: "Priya" },
    sourceId: "EVT1",
    ...over,
  };
}

describe("ReviewNotifier", () => {
  it("sends one message per event, in the recipient's language, to their bell and devices", async () => {
    const { notifier, rec, clip } = setup();
    await notifier.send(notice(clip));
    expect(rec.notices).toHaveLength(1);
    expect(rec.notices[0]).toMatchObject({
      kind: "clip-review",
      idempotencyKey: "clip-review:approved:EVT1",
      thread: `${IDS.run}:${clip}`,
      data: { by: "client", who: "Priya", name: "Editor Ravi" },
    });
  });

  it("names a client who gave no name as a client, and Aksharo's own return to review as nobody", async () => {
    const { notifier, rec, clip } = setup();
    await notifier.send(notice(clip, { actor: { kind: "client", name: null } }));
    await notifier.send(
      notice(clip, { verdict: "reopened", actor: { kind: "system" }, sourceId: "EVT2" }),
    );
    expect(rec.notices.map((entry) => [entry.data?.["by"], entry.data?.["who"]])).toEqual([
      ["guest", ""],
      ["system", ""],
    ]);
  });

  it("falls back to the part of a member's address before the @", async () => {
    const { memory, notifier, rec, clip } = setup();
    const viewer = memory.tables.user.find((row) => row["id"] === IDS.viewer);
    expect(viewer?.["name"]).toBeNull();
    await notifier.send(notice(clip, { actor: { kind: "member", userId: IDS.viewer } }));
    expect(rec.notices[0]?.data).toMatchObject({ by: "member", who: "viewer" });
  });

  it("leaves the video out rather than inventing one, so the language's own words are used", async () => {
    const { memory, notifier, rec, clip } = setup();
    const run = memory.tables.repurposeRun[0];
    if (run !== undefined) run["sourceTitle"] = null;
    const project = memory.tables.project[0];
    if (project !== undefined) project["title"] = "   ";
    await notifier.send(notice(clip));
    expect(rec.notices[0]?.data).not.toHaveProperty("video");
  });

  it("never throws, even when sending does", async () => {
    const { memory, clip } = setup();
    const failing = new ReviewNotifier(
      memory.prisma,
      {
        enqueue: async () => {
          throw new Error("redis down");
        },
      } as unknown as NotifyService,
      ENV,
    );
    await expect(failing.send(notice(clip))).resolves.toBeUndefined();
  });

  it("sends nothing for a run of another workspace", async () => {
    const { notifier, rec, clip } = setup();
    await notifier.send(notice(clip, { workspaceId: IDS.otherWs }));
    expect(rec.notices).toEqual([]);
  });
});
