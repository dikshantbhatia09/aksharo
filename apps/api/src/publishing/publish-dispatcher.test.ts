import { describe, expect, it } from "vitest";

import { IDS, seedClip, type Row } from "./memory-prisma.test-support.js";
import { checkGap, scheduledCheckAt } from "./publish-dispatcher.js";
import {
  VIDEO_BYTES,
  channelIdOf,
  connectEverything,
  publishingHarness,
  type Harness,
} from "./publishing-harness.test-support.js";
import { AUTO_ATTEMPTS, UNCERTAIN_CHECKS } from "./publishing.constants.js";

const EPISODE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

async function harnessWith(
  integration: string,
  when: { kind: "now" } | { kind: "at"; at: string },
  options: Parameters<typeof publishingHarness>[0] = {},
): Promise<{ harness: Harness; id: string }> {
  const harness = publishingHarness(options);
  connectEverything(harness.postiz);
  seedClip(harness.db);
  await harness.service.status(IDS.ws);
  const { posts } = await harness.service.publish(IDS.ws, IDS.user, IDS.run, IDS.clip, {
    channelIds: [channelIdOf(harness, integration)],
    when,
  });
  return { harness, id: posts[0]?.id ?? "" };
}

function row(harness: Harness, id: string): Row {
  const found = harness.db.tables.publishTarget.find((entry) => entry["id"] === id);
  if (found === undefined) throw new Error("no row");
  return found;
}

const dispatch = (harness: Harness, id: string, attemptNo = 1) =>
  harness.dispatcher.dispatch({ schemaVersion: 1, publishTargetId: id, attemptNo });

/** Run the reconciler for whatever check is due next. */
async function reconcile(harness: Harness, id: string) {
  return harness.dispatcher.reconcile({
    schemaVersion: 1,
    publishTargetId: id,
    checkNo: Number(row(harness, id)["checkNo"]) + 1,
  });
}

describe("dispatch: a post going out now", () => {
  it("uploads the frozen captioned video once, then creates the post with its text and settings", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await expect(dispatch(harness, id)).resolves.toBe("submitted");

    // The 9:16 render, read from the store over the API's own endpoint.
    expect(harness.reads).toEqual([expect.stringMatching(/exports\/01JCEXP916.*\.mp4$/)]);
    expect(harness.postiz.uploads).toEqual([
      expect.objectContaining({ type: "video/mp4", bytes: VIDEO_BYTES.length }),
    ]);
    const post = harness.postiz.post(0);
    expect(post).toMatchObject({
      integrationId: "int-ig",
      type: "now",
      media: [{ id: "media-1", path: harness.postiz.uploads[0]?.path }],
      settings: { __type: "instagram-standalone", post_type: "post", collaborators: [] },
    });
    expect(post.content).toBe(
      `<p>Why most people never save</p><p></p><p>Watch the full episode: ${EPISODE}</p>`,
    );
    expect(row(harness, id)).toMatchObject({
      status: "processing",
      externalPostId: post.id,
      externalMediaId: "media-1",
      externalStatus: "QUEUE",
      checkNo: 0,
    });
  });

  it("records the public link once the platform has it", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await dispatch(harness, id);
    await expect(reconcile(harness, id)).resolves.toBe("waiting");
    expect(row(harness, id)).toMatchObject({ status: "processing", checkNo: 1 });

    harness.postiz.post(0).state = "PUBLISHED";
    harness.postiz.post(0).releaseURL = "https://www.instagram.com/reel/abc123/";
    await expect(reconcile(harness, id)).resolves.toBe("published");
    expect(row(harness, id)).toMatchObject({
      status: "published",
      externalUrl: "https://www.instagram.com/reel/abc123/",
      nextCheckAt: null,
    });
    expect(harness.db.tables.publishBatch[0]).toMatchObject({
      status: "published",
      publishedCount: 1,
    });
  });

  it("never records a link that is not HTTPS", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await dispatch(harness, id);
    harness.postiz.post(0).state = "PUBLISHED";
    harness.postiz.post(0).releaseURL = "javascript:alert(1)";
    await reconcile(harness, id);
    expect(row(harness, id)).toMatchObject({ status: "published", externalUrl: null });
  });

  it("gives up waiting after two hours and asks a person instead of polling for ever", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await dispatch(harness, id);
    harness.setNow(harness.now() + 2 * 60 * 60_000 + 60_000);
    await expect(reconcile(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({
      status: "action_required",
      lastErrorCode: "publishing/uncertain_outcome",
    });
  });
});

describe("dispatch: a scheduled post", () => {
  it("hands Postiz the post with its date, and looks again right after it", async () => {
    const at = "2026-10-05T13:30:00.000Z";
    const { harness, id } = await harnessWith("int-yt", { kind: "at", at });
    await dispatch(harness, id);
    expect(harness.postiz.post(0)).toMatchObject({
      type: "schedule",
      publishDate: at,
      settings: expect.objectContaining({
        __type: "youtube",
        title: "Why most people never save",
        type: "public",
      }),
    });
    const target = row(harness, id);
    expect(target["status"]).toBe("scheduled");
    expect((target["nextCheckAt"] as Date).getTime()).toBeLessThanOrEqual(Date.parse(at) + 90_000);
  });

  it("mirrors a post moved in Postiz's calendar, and cancels one deleted there", async () => {
    const { harness, id } = await harnessWith("int-yt", {
      kind: "at",
      at: "2026-10-05T13:30:00.000Z",
    });
    await dispatch(harness, id);
    harness.postiz.post(0).publishDate = "2026-10-09T13:30:00.000Z";
    await expect(reconcile(harness, id)).resolves.toBe("waiting");
    expect((row(harness, id)["scheduledAt"] as Date).toISOString()).toBe(
      "2026-10-09T13:30:00.000Z",
    );

    harness.postiz.post(0).deleted = true;
    await expect(reconcile(harness, id)).resolves.toBe("cancelled");
    expect(row(harness, id)).toMatchObject({
      status: "cancelled",
      lastErrorSafeMessage: "It was deleted where it was scheduled.",
    });
  });
});

describe("dispatch: when the answer is lost", () => {
  it("never sends again; finds the post Postiz did create and adopts it", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.postiz.failures.push({
      method: "POST",
      path: "/posts",
      status: 502,
      afterCreate: true,
    });
    await expect(dispatch(harness, id)).resolves.toBe("uncertain");
    expect(row(harness, id)).toMatchObject({
      status: "submitted",
      externalPostId: null,
      lastErrorCode: "publishing/uncertain_outcome",
    });
    // A second dispatch of the same attempt does nothing.
    await expect(dispatch(harness, id)).resolves.toBe("skipped");

    await expect(reconcile(harness, id)).resolves.toBe("waiting");
    expect(harness.postiz.posts).toHaveLength(1);
    expect(row(harness, id)).toMatchObject({
      status: "processing",
      externalPostId: harness.postiz.post(0).id,
      lastErrorCode: null,
    });
  });

  it("counts a post that never appears as not accepted, and lets it be tried again", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.postiz.failures.push({ method: "POST", path: "/posts", status: "timeout" });
    await dispatch(harness, id);
    for (let check = 1; check < UNCERTAIN_CHECKS; check += 1) {
      await expect(reconcile(harness, id)).resolves.toBe("waiting");
    }
    await expect(reconcile(harness, id)).resolves.toBe("failed");
    const target = row(harness, id);
    expect(target).toMatchObject({
      status: "failed_retryable",
      lastErrorCode: "publishing/uncertain_outcome",
    });
    expect(target["retryAfter"]).toBeInstanceOf(Date);
    expect(harness.postiz.posts).toHaveLength(0);
  });
});

describe("dispatch: refusals", () => {
  it("waits out Postiz's hourly limit without spending an attempt, and holds every post meanwhile", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.postiz.failures.push({
      method: "POST",
      path: "/posts",
      status: 429,
      headers: { "retry-after": "600" },
    });
    await expect(dispatch(harness, id)).resolves.toBe("deferred");
    const target = row(harness, id);
    expect(target).toMatchObject({
      status: "ready",
      attemptNo: 1,
      lastErrorCode: "publishing/rate_limited",
    });
    expect((target["retryAfter"] as Date).getTime()).toBe(harness.now() + 600_000);
    // Still inside the wait: not even the upload is repeated.
    const calls = harness.postiz.calls.length;
    await expect(dispatch(harness, id)).resolves.toBe("deferred");
    expect(harness.postiz.calls).toHaveLength(calls);
    // After it: the upload is reused and the post goes.
    harness.setNow(harness.now() + 601_000);
    await expect(dispatch(harness, id)).resolves.toBe("submitted");
    expect(harness.postiz.uploads).toHaveLength(1);
  });

  it("fails for good, in a plain sentence, when the platform refuses the text", async () => {
    const { harness, id } = await harnessWith("int-x", { kind: "now" });
    harness.postiz.failures.push({
      method: "POST",
      path: "/posts",
      status: 400,
      body: {
        statusCode: 400,
        provider: "x",
        name: "X",
        message: "post is too long, please fix it",
      },
    });
    await expect(dispatch(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({
      status: "failed_permanent",
      lastErrorCode: "publishing/validation_failed",
      lastErrorSafeMessage: "The text is too long for X. Shorten it and post again.",
    });
  });

  it("asks for the account again when it was removed from Postiz", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.postiz.integrations = harness.postiz.integrations.filter(
      (entry) => entry.id !== "int-ig",
    );
    await harness.directory.integrations({ fresh: true });
    await expect(dispatch(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({
      status: "action_required",
      lastErrorCode: "publishing/account_disconnected",
    });
    expect(harness.postiz.uploads).toHaveLength(0);
  });

  it("will not send a video that has changed or gone since the post was confirmed", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    const exported = harness.db.tables.export.find(
      (entry) => entry["id"] === row(harness, id)["exportId"],
    );
    if (exported === undefined) throw new Error("no export");
    exported["storageKey"] = "ws/other/exports/replaced.mp4";
    await expect(dispatch(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({
      status: "failed_permanent",
      lastErrorCode: "publishing/artifact_stale",
    });
    expect(harness.reads).toEqual([]);
  });

  it("tries a failed upload again by itself while attempts remain", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.postiz.failures.push({ method: "POST", path: "/upload", status: 503 });
    await expect(dispatch(harness, id)).resolves.toBe("failed");
    const target = row(harness, id);
    expect(target).toMatchObject({
      status: "failed_retryable",
      lastErrorCode: "publishing/provider_unavailable",
    });
    // Base wait, jitter pinned to the middle.
    expect((target["retryAfter"] as Date).getTime()).toBe(harness.now() + 60_000);
    expect(AUTO_ATTEMPTS).toBeGreaterThan(1);
  });

  it("holds a post whose feature was switched off after it was confirmed", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    harness.access.environment = { POSTIZ_WORKSPACE_IDS: "" };
    await expect(dispatch(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({ status: "action_required" });
    expect(harness.postiz.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("ignores an old attempt's job and a post already handled", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await expect(dispatch(harness, id, 7)).resolves.toBe("stale");
    await dispatch(harness, id);
    await expect(dispatch(harness, id)).resolves.toBe("skipped");
    await expect(
      harness.dispatcher.dispatch({
        schemaVersion: 1,
        publishTargetId: "01JCNKNOWN0000000000000000",
        attemptNo: 1,
      }),
    ).resolves.toBe("missing");
  });
});

describe("what a person is told", () => {
  it("never names the tools behind posting, whatever Postiz refused", async () => {
    const refusals = [
      { status: 400, body: { message: "post is too long, please fix it" } },
      { status: 400, body: { message: "Integration with id x not found" } },
      { status: 400, body: { message: "title must be shorter than or equal to 100 characters" } },
      { status: 400, body: { message: "Unsupported file type." } },
      { status: 400, body: { msg: "No subscription found" } },
      { status: 400, body: { message: "something new" } },
      { status: 401, body: { msg: "Invalid API key" } },
      { status: 404, body: { message: "Cannot POST /public/v1/posts" } },
      { status: 413, body: { message: "too large" } },
      { status: 503, body: { message: "down" } },
    ] as const;
    for (const refusal of refusals) {
      const { harness, id } = await harnessWith("int-ig", { kind: "now" });
      harness.postiz.failures.push({ method: "POST", path: "/posts", ...refusal });
      await dispatch(harness, id);
      const message = String(row(harness, id)["lastErrorSafeMessage"] ?? "");
      expect(message, JSON.stringify(refusal)).not.toBe("");
      expect(message, JSON.stringify(refusal)).not.toMatch(/postiz|queue|worker|webhook|redis/i);
    }
  });
});

describe("reconcile: a post the platform did not take", () => {
  it("fails it for a person to retry, without trying again by itself", async () => {
    const { harness, id } = await harnessWith("int-li", { kind: "now" });
    await dispatch(harness, id);
    harness.postiz.post(0).state = "ERROR";
    await expect(reconcile(harness, id)).resolves.toBe("failed");
    expect(row(harness, id)).toMatchObject({
      status: "failed_retryable",
      retryAfter: null,
      lastErrorSafeMessage:
        "LinkedIn did not take the post. Check the account where it is connected, then try again.",
    });
  });

  it("keeps waiting, with nothing changed, when Postiz cannot be asked", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await dispatch(harness, id);
    harness.postiz.failures.push({ method: "GET", path: "/posts", status: "refused" });
    await expect(reconcile(harness, id)).resolves.toBe("waiting");
    expect(row(harness, id)).toMatchObject({ status: "processing", checkNo: 1 });
  });

  it("ignores a stale check", async () => {
    const { harness, id } = await harnessWith("int-ig", { kind: "now" });
    await dispatch(harness, id);
    await expect(
      harness.dispatcher.reconcile({ schemaVersion: 1, publishTargetId: id, checkNo: 5 }),
    ).resolves.toBe("stale");
  });
});

describe("check timing", () => {
  it("backs off from 30 s to 10 min while a post goes out", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(checkGap)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });

  it("looks at a scheduled post rarely until its time, then right after it", () => {
    const now = 0;
    const day = 24 * 60 * 60_000;
    expect(scheduledCheckAt(10 * 60_000, now)).toBe(10 * 60_000 + 90_000);
    expect(scheduledCheckAt(30 * day, now)).toBe(Math.round((30 * day) / 8));
    expect(scheduledCheckAt(3 * day, now)).toBe(day);
  });
});
