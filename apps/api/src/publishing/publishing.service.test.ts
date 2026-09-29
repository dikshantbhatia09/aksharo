import { describe, expect, it } from "vitest";

import { IDS, seedClip } from "./memory-prisma.test-support.js";
import {
  channelIdOf,
  connectEverything,
  publishingHarness,
  type Harness,
} from "./publishing-harness.test-support.js";
import { PUBLISHING_ERRORS } from "./publishing.constants.js";
import { AppException } from "../common/errors/error-codes.js";

const EPISODE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A harness with every channel connected, one clip seeded, and the list read once. */
async function ready(options: Parameters<typeof publishingHarness>[0] = {}): Promise<Harness> {
  const harness = publishingHarness(options);
  connectEverything(harness.postiz);
  seedClip(harness.db);
  await harness.service.status(IDS.ws);
  return harness;
}

describe("PublishingService.status", () => {
  it("is quiet while the feature is off, and says so", async () => {
    const harness = publishingHarness({ flags: { publishing_postiz: false } });
    await expect(harness.service.status(IDS.ws)).resolves.toMatchObject({
      enabled: false,
      available: false,
      reason: "flag_off",
      postizUrl: null,
    });
  });

  it("names what is missing: this workspace, the key, the service, the accounts", async () => {
    await expect(
      publishingHarness({ allowed: [IDS.otherWs] }).service.status(IDS.ws),
    ).resolves.toMatchObject({ enabled: true, reason: "not_this_workspace", postizUrl: null });

    await expect(
      publishingHarness({ configured: false }).service.status(IDS.ws),
    ).resolves.toMatchObject({ reason: "not_configured", postizUrl: "http://localhost:4007" });

    const refused = publishingHarness();
    refused.postiz.failures.push({ path: "/integrations", status: 401 });
    await expect(refused.service.status(IDS.ws)).resolves.toMatchObject({ reason: "key_refused" });

    const down = publishingHarness();
    down.postiz.failures.push({ path: "/integrations", status: "refused" });
    await expect(down.service.status(IDS.ws)).resolves.toMatchObject({ reason: "unreachable" });

    await expect(publishingHarness().service.status(IDS.ws)).resolves.toMatchObject({
      reason: "no_channels",
      message: "No accounts are connected yet. Connect them in Postiz, then come back.",
    });
  });

  it("counts the accounts that can be posted to: not TikTok while its flag is off, not Pinterest", async () => {
    const harness = await ready();
    await expect(harness.service.status(IDS.ws)).resolves.toEqual({
      enabled: true,
      available: true,
      reason: null,
      message: null,
      postizUrl: "http://localhost:4007",
      channelCount: 6,
    });
  });
});

describe("PublishingService.channels", () => {
  it("mirrors Postiz's channels into the workspace, and never shows a picture over plain HTTP", async () => {
    const harness = await ready();
    const { channels } = await harness.service.channels(IDS.ws);
    expect(channels.map((channel) => [channel.platform, channel.supported, channel.note])).toEqual([
      ["Instagram", true, null],
      ["Facebook", true, null],
      ["YouTube", true, null],
      ["LinkedIn", true, null],
      ["X", true, null],
      ["TikTok", true, "Posting to TikTok is not switched on yet."],
      ["Threads", true, null],
      ["Pinterest", false, "Posting here from Aksharo is not available yet."],
    ]);
    expect(channels[0]?.avatarUrl).toBe("https://cdn.example.com/ig.jpg");
    expect(channels[4]?.avatarUrl).toBeNull();
    // One row per supported channel, none for Pinterest; no token anywhere.
    expect(harness.db.tables.channelConnection).toHaveLength(7);
    expect(JSON.stringify(harness.db.tables.channelConnection)).not.toContain("test-postiz-key");
  });

  it("marks a channel removed from Postiz as disconnected rather than deleting it", async () => {
    const harness = await ready();
    harness.postiz.integrations = harness.postiz.integrations.filter(
      (entry) => entry.id !== "int-x",
    );
    await harness.directory.integrations({ fresh: true });
    await harness.service.channels(IDS.ws);
    const x = harness.db.tables.channelConnection.find(
      (row) => row["externalIntegrationId"] === "int-x",
    );
    expect(x?.["connectionStatus"]).toBe("disconnected");
  });

  it("answers 404 while the feature is off", async () => {
    const harness = publishingHarness({ flags: { publishing_postiz: false } });
    const error = await refusal(harness.service.channels(IDS.ws));
    expect(error.code).toBe(PUBLISHING_ERRORS.disabled);
    expect(error.httpStatus).toBe(404);
  });
});

describe("PublishingService.plan", () => {
  it("offers each account the shape it takes and the text it starts with", async () => {
    const harness = await ready();
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    const byPlatform = Object.fromEntries(
      plan.channels.map((channel) => [
        channel.platform,
        [channel.surface, channel.shape, channel.ready],
      ]),
    );
    expect(byPlatform).toEqual({
      Instagram: ["Reel", "9:16", true],
      Facebook: ["Feed video", "4:5", true],
      YouTube: ["Short", "9:16", true],
      LinkedIn: ["Video", "1:1", true],
      X: ["Video", "1:1", true],
      TikTok: ["Video", "9:16", false],
      Threads: ["Video", "9:16", true],
    });
    expect(plan.texts.youtube).toMatchObject({
      title: "Why most people never save",
      body: `Watch the full episode: ${EPISODE}`,
      titleLimit: 100,
      titleRequired: true,
    });
    expect(plan.texts.x).toMatchObject({ bodyLimit: 280, linkLength: 23 });
    // 11:30 in India: tonight at 7 is still free for everyone.
    expect(Object.values(plan.nextDaily)).toContain("2026-10-01T13:30:00.000Z");
  });

  it("falls back to vertical while the better shape is being made, and says so", async () => {
    const harness = publishingHarness();
    connectEverything(harness.postiz);
    seedClip(harness.db, { ready: ["9:16"], making: ["4:5", "1:1", "16:9"] });
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    const linkedin = plan.channels.find((channel) => channel.platform === "LinkedIn");
    expect(linkedin).toMatchObject({
      shape: "9:16",
      ready: true,
      note: "The square video is still being made, so this posts the vertical (9:16) one.",
    });
  });

  it("keeps a clip too long for X off X", async () => {
    const harness = publishingHarness();
    connectEverything(harness.postiz);
    seedClip(harness.db, { durationMs: 170_000 });
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    expect(plan.channels.find((channel) => channel.platform === "X")).toMatchObject({
      ready: false,
      note: "Too long for X: 2:20 at most.",
    });
  });

  it("returns only the status when posting is not available", async () => {
    const harness = publishingHarness({ configured: false });
    seedClip(harness.db);
    const plan = await harness.service.plan(IDS.ws, IDS.run, IDS.clip);
    expect(plan.status.reason).toBe("not_configured");
    expect(plan.channels).toEqual([]);
  });

  it("finds nothing in another workspace's run", async () => {
    const harness = await ready();
    harness.access.environment = { POSTIZ_WORKSPACE_IDS: `${IDS.ws},${IDS.otherWs}` };
    const error = await refusal(harness.service.plan(IDS.otherWs, IDS.run, IDS.clip));
    expect(error.code).toBe(PUBLISHING_ERRORS.clipNotFound);
  });
});

describe("PublishingService.publish", () => {
  it("freezes one post per account - its shape, text, video and settings - and queues each now", async () => {
    const harness = await ready();
    const instagram = channelIdOf(harness, "int-ig");
    const linkedin = channelIdOf(harness, "int-li");
    const youtube = channelIdOf(harness, "int-yt");
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [instagram, linkedin, youtube],
      texts: { linkedin: { body: "My own words for LinkedIn." } },
      visibility: { youtube: "unlisted" },
      when: { kind: "now" },
    });

    expect(result.posts.map((post) => [post.platform, post.shape, post.status])).toEqual([
      ["Instagram", "9:16", "posting"],
      ["LinkedIn", "1:1", "posting"],
      ["YouTube", "9:16", "posting"],
    ]);
    const rows = harness.db.tables.publishTarget;
    expect(rows).toHaveLength(3);
    const byProvider = Object.fromEntries(rows.map((row) => [row["provider"], row]));
    expect(byProvider["linkedin"]?.["copy"]).toMatchObject({
      schemaVersion: 1,
      title: null,
      body: "My own words for LinkedIn.",
    });
    expect(byProvider["linkedin"]?.["settings"]).toMatchObject({
      provider: "linkedin",
      surface: "organization",
    });
    expect(byProvider["youtube"]?.["settings"]).toMatchObject({
      privacy: "unlisted",
      surface: "short",
    });
    expect(byProvider["instagram"]).toMatchObject({
      publishMode: "direct",
      scheduledAt: null,
      status: "ready",
      attemptNo: 1,
      idempotencyKey: `postiz:${IDS.clip}:${instagram}:now`,
    });
    expect(String(byProvider["instagram"]?.["artifactFingerprint"])).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.db.tables.publishBatch).toEqual([
      expect.objectContaining({
        runId: IDS.run,
        mode: "now",
        confirmedBy: IDS.user,
        targetCount: 3,
      }),
    ]);
    expect(harness.dispatched.map((job) => job.attemptNo)).toEqual([1, 1, 1]);
    expect(harness.audits[0]).toMatchObject({
      action: "publishing.post.created",
      workspaceId: IDS.ws,
    });
  });

  it("schedules at a picked time, in the zone it was picked in", async () => {
    const harness = await ready();
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [channelIdOf(harness, "int-fb")],
      when: { kind: "at", at: "2026-10-03T19:00:00+05:30", timezone: "Asia/Kolkata" },
    });
    expect(result.posts[0]).toMatchObject({
      status: "posting",
      shape: "4:5",
      scheduledAt: "2026-10-03T13:30:00.000Z",
    });
    expect(harness.db.tables.publishBatch[0]).toMatchObject({
      mode: "scheduled",
      timezone: "Asia/Kolkata",
    });
    expect(harness.db.tables.publishTarget[0]).toMatchObject({ publishMode: "schedule" });
  });

  it("refuses a time in the past or a zone it does not know", async () => {
    const harness = await ready();
    const past = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-fb")],
        when: { kind: "at", at: "2026-10-01T06:00:30Z" },
      }),
    );
    expect(past.code).toBe(PUBLISHING_ERRORS.timeInvalid);
    const zone = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-fb")],
        when: { kind: "daily", timezone: "Mars/Olympus" },
      }),
    );
    expect(zone.code).toBe(PUBLISHING_ERRORS.timeInvalid);
  });

  it("puts 'one a day' on each account's next free day at 7 pm India time", async () => {
    const harness = await ready();
    const instagram = channelIdOf(harness, "int-ig");
    // Instagram already has a post tonight (made in Postiz by hand).
    harness.postiz.posts.push({
      id: "manual-1",
      integrationId: "int-ig",
      identifier: "instagram-standalone",
      content: "<p>hand-made</p>",
      settings: {},
      media: [],
      type: "schedule",
      publishDate: "2026-10-01T13:30:00.000Z",
      state: "QUEUE",
      releaseURL: null,
      deleted: false,
    });
    const result = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [instagram, channelIdOf(harness, "int-yt")],
      when: { kind: "daily" },
    });
    expect(result.posts.map((post) => [post.platform, post.scheduledAt])).toEqual([
      ["YouTube", "2026-10-01T13:30:00.000Z"],
      ["Instagram", "2026-10-02T13:30:00.000Z"],
    ]);
  });

  it("holds a clip to one live post per account and slot, unless posted again on purpose", async () => {
    const harness = await ready();
    const input = { channelIds: [channelIdOf(harness, "int-ig")], when: { kind: "now" as const } };
    await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, input);
    const again = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, input),
    );
    expect(again.code).toBe(PUBLISHING_ERRORS.alreadyPosted);
    expect(again.message).toBe("This clip is already posted, or being posted, on Crest Mond.");
    expect(again.httpStatus).toBe(409);
    await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, { ...input, again: true });
    expect(harness.db.tables.publishTarget).toHaveLength(2);
  });

  it("will not put a clip on 'one a day' for an account it is already going to", async () => {
    const harness = await ready();
    const youtube = channelIdOf(harness, "int-yt");
    await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [youtube],
      when: { kind: "at", at: "2026-10-05T13:30:00Z" },
    });
    const error = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [youtube],
        when: { kind: "daily" },
      }),
    );
    expect(error.code).toBe(PUBLISHING_ERRORS.alreadyPosted);
    expect(error.message).toBe(
      "This clip already has a post on Crest Mond TV. Pick a time instead to post it there again.",
    );
    // A second picked time is deliberate, so it is allowed.
    await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [youtube],
      when: { kind: "at", at: "2026-10-09T13:30:00Z" },
    });
    expect(harness.db.tables.publishTarget).toHaveLength(2);
  });

  it("refuses text that does not fit the platform", async () => {
    const harness = await ready();
    const error = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-x")],
        texts: { x: { body: "a".repeat(300) } },
        when: { kind: "now" },
      }),
    );
    expect(error.code).toBe(PUBLISHING_ERRORS.textInvalid);
    expect(error.message).toBe("The X text is too long: 280 characters at most.");
  });

  it("refuses TikTok while its own flag is off, and an account it does not know", async () => {
    const harness = await ready();
    const tiktok = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-tt")],
        when: { kind: "now" },
      }),
    );
    expect(tiktok.code).toBe(PUBLISHING_ERRORS.channelUnavailable);
    const unknown = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: ["01JCNKNOWN0000000000000000"],
        when: { kind: "now" },
      }),
    );
    expect(unknown.code).toBe(PUBLISHING_ERRORS.channelUnknown);
  });

  it("refuses a clip with no finished captioned video, and a removed one", async () => {
    const harness = publishingHarness();
    connectEverything(harness.postiz);
    seedClip(harness.db, { ready: [], making: ["9:16"] });
    await harness.service.status(IDS.ws);
    const waiting = await refusal(
      harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      }),
    );
    expect(waiting.code).toBe(PUBLISHING_ERRORS.notReady);
    expect(waiting.message).toBe("Instagram: Its video is still being made.");

    const removed = publishingHarness();
    connectEverything(removed.postiz);
    seedClip(removed.db, { removed: true });
    await removed.service.status(IDS.ws);
    const gone = await refusal(
      removed.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(removed, "int-ig")],
        when: { kind: "now" },
      }),
    );
    expect(gone.code).toBe(PUBLISHING_ERRORS.notReady);
  });

  it("answers 503 when this workspace may not post, and 404 while the feature is off", async () => {
    const other = await ready({ allowed: [IDS.otherWs] });
    const notAllowed = await refusal(
      other.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: ["01JCNKNOWN0000000000000000"],
        when: { kind: "now" },
      }),
    );
    expect(notAllowed).toMatchObject({ code: PUBLISHING_ERRORS.notConfigured, httpStatus: 503 });
    const off = await ready({ flags: { publishing_postiz: false } });
    const disabled = await refusal(
      off.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: ["01JCNKNOWN0000000000000000"],
        when: { kind: "now" },
      }),
    );
    expect(disabled).toMatchObject({ code: PUBLISHING_ERRORS.disabled, httpStatus: 404 });
  });
});

describe("PublishingService.daily", () => {
  it("spreads the chosen clips one a day per account, skipping what cannot go", async () => {
    const harness = await ready();
    seedClip(harness.db, {
      clipId: "01JCC11PB0000000000000000B",
      candidateId: "01JCCANDB0000000000000000B",
    });
    seedClip(harness.db, {
      clipId: "01JCC11PC0000000000000000C",
      candidateId: "01JCCANDC0000000000000000C",
      durationMs: 170_000,
    });
    const x = channelIdOf(harness, "int-x");
    const instagram = channelIdOf(harness, "int-ig");
    const result = await harness.service.daily(IDS.ws, IDS.user, IDS.run, {
      clipIds: [IDS.clip, "01JCC11PB0000000000000000B", "01JCC11PC0000000000000000C"],
      channelIds: [instagram, x],
      time: "19:00",
    });
    expect(
      result.posts.map((post) => [post.platform, post.clipId.slice(-1), post.scheduledAt]),
    ).toEqual([
      ["Instagram", "0", "2026-10-01T13:30:00.000Z"],
      ["X", "0", "2026-10-01T13:30:00.000Z"],
      ["Instagram", "B", "2026-10-02T13:30:00.000Z"],
      ["X", "B", "2026-10-02T13:30:00.000Z"],
      ["Instagram", "C", "2026-10-03T13:30:00.000Z"],
    ]);
    expect(result.skipped).toEqual([
      {
        clipId: "01JCC11PC0000000000000000C",
        channelId: x,
        reason: "Too long for X: 2:20 at most.",
      },
    ]);
    expect(harness.dispatched).toHaveLength(5);
  });
});

describe("PublishingService.list, cancel and retry", () => {
  it("lists a run's posts, one clip's with a filter, and none of another workspace's", async () => {
    const harness = await ready();
    await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
      channelIds: [channelIdOf(harness, "int-ig")],
      when: { kind: "now" },
    });
    expect((await harness.service.list(IDS.ws, IDS.run)).posts).toHaveLength(1);
    expect((await harness.service.list(IDS.ws, IDS.run, IDS.clip)).posts).toHaveLength(1);
    expect(
      (await harness.service.list(IDS.ws, IDS.run, "01JCC11PZ0000000000000000Z")).posts,
    ).toEqual([]);
    const other = await refusal(harness.service.list(IDS.otherWs, IDS.run));
    expect(other.httpStatus).toBe(404);
  });

  it("cancels a post not yet sent without asking Postiz, and a scheduled one by deleting it there", async () => {
    const harness = await ready();
    const [waiting] = (
      await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      })
    ).posts;
    const cancelled = await harness.service.cancel(IDS.ws, IDS.user, waiting?.id ?? "");
    expect(cancelled).toMatchObject({ status: "cancelled", canCancel: false });

    const [scheduled] = (
      await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-yt")],
        when: { kind: "at", at: "2026-10-05T13:30:00Z" },
      })
    ).posts;
    await harness.dispatcher.dispatch({
      schemaVersion: 1,
      publishTargetId: scheduled?.id ?? "",
      attemptNo: 1,
    });
    expect(harness.postiz.post(0).deleted).toBe(false);
    const view = await harness.service.cancel(IDS.ws, IDS.user, scheduled?.id ?? "");
    expect(view.status).toBe("cancelled");
    expect(harness.postiz.post(0).deleted).toBe(true);
    expect(harness.audits.map((event) => event.action)).toContain("publishing.post.cancelled");
  });

  it("will not cancel a post that is out, or one being sent this moment", async () => {
    const harness = await ready();
    const [post] = (
      await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      })
    ).posts;
    await harness.dispatcher.dispatch({
      schemaVersion: 1,
      publishTargetId: post?.id ?? "",
      attemptNo: 1,
    });
    const busy = await refusal(harness.service.cancel(IDS.ws, IDS.user, post?.id ?? ""));
    expect(busy.code).toBe(PUBLISHING_ERRORS.notCancellable);

    harness.postiz.post(0).state = "PUBLISHED";
    harness.postiz.post(0).releaseURL = "https://www.instagram.com/reel/abc/";
    await harness.dispatcher.checkNow(post?.id ?? "");
    const out = await refusal(harness.service.cancel(IDS.ws, IDS.user, post?.id ?? ""));
    expect(out.message).toBe(
      "This is already posted. Remove it on Instagram if it should not be there.",
    );
  });

  it("retries a failed post as a new attempt, clearing Postiz's failed copy first", async () => {
    const harness = await ready();
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
    const failed = (await harness.service.list(IDS.ws, IDS.run)).posts[0];
    expect(failed).toMatchObject({ status: "failed", canRetry: true });

    const retried = await harness.service.retry(IDS.ws, IDS.user, id);
    expect(retried).toMatchObject({ status: "posting", error: null });
    expect(harness.postiz.post(0).deleted).toBe(true);
    expect(harness.dispatched.at(-1)).toMatchObject({ targetId: id, attemptNo: 2 });
    // The upload is reused: no second copy of the file.
    await harness.dispatcher.dispatch({ schemaVersion: 1, publishTargetId: id, attemptNo: 2 });
    expect(harness.postiz.uploads).toHaveLength(1);
    expect(harness.postiz.posts).toHaveLength(2);
  });

  it("does not retry a post refused for good", async () => {
    const harness = await ready();
    const [post] = (
      await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
        channelIds: [channelIdOf(harness, "int-ig")],
        when: { kind: "now" },
      })
    ).posts;
    harness.postiz.failures.push({
      method: "POST",
      path: "/posts",
      status: 400,
      body: { message: "post is too long, please fix it" },
    });
    await harness.dispatcher.dispatch({
      schemaVersion: 1,
      publishTargetId: post?.id ?? "",
      attemptNo: 1,
    });
    const error = await refusal(harness.service.retry(IDS.ws, IDS.user, post?.id ?? ""));
    expect(error.code).toBe(PUBLISHING_ERRORS.notRetryable);
  });
});
