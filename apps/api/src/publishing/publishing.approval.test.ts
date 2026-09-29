import { describe, expect, it } from "vitest";

import {
  IDS,
  renderAgain,
  requireApproval,
  reviewClip,
  seedClip,
} from "./memory-prisma.test-support.js";
import {
  channelIdOf,
  connectEverything,
  publishingHarness,
  type Harness,
} from "./publishing-harness.test-support.js";
import { PUBLISHING_ERRORS } from "./publishing.constants.js";
import { AppException } from "../common/errors/error-codes.js";
import { APPROVAL_MESSAGES } from "../repurpose/review/review-state.js";

/**
 * "Clips need approval before posting" (2026-10-03): the publishing routes
 * against the real `ClipApprovalGate`, over the same memory database.
 */

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function ready(): Promise<Harness> {
  const harness = publishingHarness();
  connectEverything(harness.postiz);
  seedClip(harness.db);
  await harness.service.status(IDS.ws);
  return harness;
}

const SECOND_CLIP = "01JCC11PB00000000000000000";

describe("posting while the workspace needs approval", () => {
  it("posts as before while the setting is off, whatever the review says", async () => {
    const harness = await ready();
    requireApproval(harness.db, false);
    reviewClip(harness.db, "changes_requested");
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [channelIdOf(harness, "int-ig")],
      when: { kind: "now" },
    });
    expect(result.posts).toHaveLength(1);
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    expect(plan.approval).toEqual({ required: false, approved: true, message: null });
  });

  it("refuses a clip that is not approved, before asking the publishing service anything", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    const requests = harness.postiz.calls.length;
    const pending = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      }),
    );
    expect(pending.code).toBe(PUBLISHING_ERRORS.notApproved);
    expect(pending.httpStatus).toBe(409);
    expect(pending.message).toBe(APPROVAL_MESSAGES.pending);
    expect(harness.postiz.calls.length).toBe(requests);
    expect(harness.db.tables.publishTarget).toEqual([]);

    reviewClip(harness.db, "changes_requested");
    const changes = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      }),
    );
    expect(changes.message).toBe(APPROVAL_MESSAGES.changes_requested);
  });

  it("tells the Post dialog up front, and marks every account not ready with the reason", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    expect(plan.approval).toEqual({
      required: true,
      approved: false,
      message: APPROVAL_MESSAGES.pending,
    });
    expect(plan.channels.every((channel) => !channel.ready)).toBe(true);
    expect(plan.channels.find((channel) => channel.platform === "Instagram")?.note).toBe(
      APPROVAL_MESSAGES.pending,
    );
  });

  it("posts an approved clip in each account's own shape when the approval covers them all", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    reviewClip(harness.db, "approved");
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [channelIdOf(harness, "int-ig"), channelIdOf(harness, "int-li")],
      when: { kind: "now" },
    });
    expect(result.posts.map((post) => [post.platform, post.shape])).toEqual([
      ["Instagram", "9:16"],
      ["LinkedIn", "1:1"],
    ]);
  });

  it("posts only the approved vertical video when that is all the approval covers", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    // A client approved the 9:16 they watched; the other shapes were not seen.
    reviewClip(harness.db, "approved", ["9:16"]);
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    const shapes = Object.fromEntries(
      plan.channels.map((channel) => [channel.platform, [channel.shape, channel.ready]]),
    );
    expect(shapes).toMatchObject({
      LinkedIn: ["9:16", true],
      Facebook: ["9:16", true],
      X: ["9:16", true],
    });
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [channelIdOf(harness, "int-li")],
      when: { kind: "now" },
    });
    expect(result.posts[0]?.shape).toBe("9:16");
  });

  it("refuses the clip once its approved video is replaced by an edit, even before review catches up", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    reviewClip(harness.db, "approved", ["9:16"]);
    renderAgain(harness.db, "9:16");
    const error = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      }),
    );
    expect(error.code).toBe(PUBLISHING_ERRORS.notApproved);
    expect(error.message).toBe(APPROVAL_MESSAGES.changed);
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    expect(plan.channels.find((channel) => channel.platform === "Instagram")).toMatchObject({
      ready: false,
      note: APPROVAL_MESSAGES.changed,
    });
  });
});

describe("'one a day' while the workspace needs approval", () => {
  it("leaves out the clips that are not approved, and says why", async () => {
    const harness = await ready();
    seedClip(harness.db, { clipId: SECOND_CLIP, candidateId: "01JCCANDB00000000000000000" });
    requireApproval(harness.db);
    reviewClip(harness.db, "approved");
    const instagram = channelIdOf(harness, "int-ig");
    const result = await harness.service.daily(IDS.ws, IDS.user, IDS.run, {
      clipIds: [IDS.clip, SECOND_CLIP],
      channelIds: [instagram],
    });
    expect(result.posts.map((post) => post.clipId)).toEqual([IDS.clip]);
    expect(result.skipped).toEqual([
      { clipId: SECOND_CLIP, channelId: instagram, reason: APPROVAL_MESSAGES.pending },
    ]);
  });

  it("answers not approved when nothing chosen is approved", async () => {
    const harness = await ready();
    seedClip(harness.db, { clipId: SECOND_CLIP, candidateId: "01JCCANDB00000000000000000" });
    requireApproval(harness.db);
    const error = await refusal(
      harness.service.daily(IDS.ws, IDS.user, IDS.run, {
        clipIds: [IDS.clip, SECOND_CLIP],
        channelIds: [channelIdOf(harness, "int-ig")],
      }),
    );
    expect(error.code).toBe(PUBLISHING_ERRORS.notApproved);
  });
});

describe("retrying a post while the workspace needs approval", () => {
  async function failedPost(harness: Harness): Promise<string> {
    const [post] = (
      await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      })
    ).posts;
    const id = post?.id ?? "";
    await harness.dispatcher.dispatch({ schemaVersion: 1, publishTargetId: id, attemptNo: 1 });
    harness.postiz.post(0).state = "ERROR";
    await harness.dispatcher.checkNow(id);
    return id;
  }

  it("sends it again while the clip is still approved with that video", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    reviewClip(harness.db, "approved");
    const id = await failedPost(harness);
    await expect(harness.service.retry(IDS.ws, IDS.user, id)).resolves.toMatchObject({
      status: "posting",
    });
  });

  it("refuses once the clip is no longer approved, or approved with another video", async () => {
    const harness = await ready();
    requireApproval(harness.db);
    reviewClip(harness.db, "approved");
    const id = await failedPost(harness);

    reviewClip(harness.db, "changes_requested");
    const changes = await refusal(harness.service.retry(IDS.ws, IDS.user, id));
    expect(changes.code).toBe(PUBLISHING_ERRORS.notApproved);
    expect(changes.message).toBe(APPROVAL_MESSAGES.changes_requested);

    // Approved again, on a new version: the frozen post is of the old one.
    renderAgain(harness.db, "9:16");
    const exportId = harness.db.tables.clipVariant.find((row) => row["aspect"] === "r9x16")?.[
      "latestExportId"
    ];
    harness.db.tables.clipReview = [
      { clipId: IDS.clip, workspaceId: IDS.ws, state: "approved", videos: { "9:16": exportId } },
    ];
    const stale = await refusal(harness.service.retry(IDS.ws, IDS.user, id));
    expect(stale.message).toBe(APPROVAL_MESSAGES.retry);
  });
});
