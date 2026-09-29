import { describe, expect, it } from "vitest";

import {
  IDS,
  renderClip,
  reviewHarness,
  seedClip,
  type ReviewHarness,
} from "./review-memory.test-support.js";
import { REVIEW_ERRORS } from "./review.constants.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { MemberCaller } from "./clip-review.service.js";

const ADMIN: MemberCaller = { userId: IDS.admin, role: "admin" };
const OWNER: MemberCaller = { userId: IDS.owner, role: "owner" };

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function link(
  h: ReviewHarness,
  options: { requireName?: boolean; expiresInDays?: number } = {},
): Promise<{ id: string; token: string }> {
  const created = await h.reviews.createLink(IDS.ws, ADMIN, IDS.run, {
    expiresInDays: options.expiresInDays ?? 7,
    requireName: options.requireName ?? false,
  });
  return { id: created.id, token: created.url.split("/").at(-1) ?? "" };
}

describe("opening a review link", () => {
  it("shows the run's clips with a 9:16 video, in video order, and nothing of the workspace", async () => {
    const h = reviewHarness();
    const late = seedClip(h.db, 1, {
      startMs: 600_000,
      rendered: ["9:16", "1:1"],
      copy: {
        summary: "Why most people never save",
        hook: "Stop doing this",
        cta: "",
        hashtags: ["#money", "#saving"],
        locale: "en",
        title: "Never save",
        description: "The one habit.",
      },
    });
    const early = seedClip(h.db, 2, { startMs: 60_000 });
    seedClip(h.db, 3, { rendered: ["1:1"] }); // no 9:16 video: not on the page
    seedClip(h.db, 4, { removed: true });
    seedClip(h.db, 5, { runId: IDS.otherRun }); // another run: never
    // The team's own comment is not the client's to see.
    await h.reviews.addMemberComment(IDS.ws, OWNER, IDS.run, early, { body: "Internal note" });
    const { token } = await link(h);

    const page = await h.clients.open(token);
    expect(page.title).toBe("Diwali vlog");
    expect(page.clips.map((clip) => clip.id)).toEqual([early, late]);
    expect(page.clips[1]).toMatchObject({
      title: "Clip 1",
      hook: "Stop doing this",
      description: "The one habit.",
      hashtags: ["#money", "#saving"],
      yourDecision: null,
      comments: [],
    });
    expect(page.clips[0]?.comments).toEqual([]);
    // Signed for twenty minutes, never as a download, and only the 9:16 file.
    expect(page.clips[1]?.video?.url).toContain("X-Amz-Expires=1200");
    expect(page.clips[1]?.video?.url).not.toContain("download");
    expect(h.signed.filter((key) => key.includes("r1x1"))).toEqual([]);
    const json = JSON.stringify(page);
    // No member, no team comment, no storage key. (The workspace id is in the
    // signed URL's path, as it is in every signed URL the product hands out.)
    for (const secret of [IDS.owner, IDS.admin, IDS.editor, "Internal note", "storageKey"]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(page).sort()).toEqual(["clips", "expiresAt", "requireName", "title"]);
  });

  it("counts a visit per half hour, not per refresh", async () => {
    const h = reviewHarness();
    seedClip(h.db, 1);
    const { token } = await link(h);
    await h.clients.open(token);
    await h.clients.open(token);
    h.setNow(Date.parse("2026-10-03T06:31:00Z"));
    await h.clients.open(token);
    expect(h.db.tables.clipReviewLink[0]).toMatchObject({ viewCount: 2 });
  });

  it("answers 404 for an unknown or malformed token, and 410 once revoked or expired", async () => {
    const h = reviewHarness();
    seedClip(h.db, 1);
    const { id, token } = await link(h, { expiresInDays: 1 });
    expect((await refusal(h.clients.open("A".repeat(24)))).code).toBe(REVIEW_ERRORS.linkNotFound);
    expect((await refusal(h.clients.open("not a token"))).httpStatus).toBe(404);
    expect((await refusal(h.clients.open(""))).httpStatus).toBe(404);

    h.setNow(Date.parse("2026-10-04T06:00:00Z"));
    const expired = await refusal(h.clients.open(token));
    expect(expired.code).toBe(REVIEW_ERRORS.linkExpired);
    expect(expired.httpStatus).toBe(410);

    h.setNow(Date.parse("2026-10-03T07:00:00Z"));
    await h.reviews.revokeLink(IDS.ws, ADMIN, IDS.run, id);
    const revoked = await refusal(h.clients.open(token));
    expect(revoked.code).toBe(REVIEW_ERRORS.linkRevoked);
    expect(revoked.httpStatus).toBe(410);
  });

  it("reaches nothing once the workspace's clips surface is off", async () => {
    const h = reviewHarness();
    seedClip(h.db, 1);
    const { token } = await link(h);
    const off = h.reviews as unknown as { assertAvailable: () => Promise<void> };
    off.assertAvailable = async () => {
      throw new Error("off");
    };
    expect((await refusal(h.clients.open(token))).code).toBe(REVIEW_ERRORS.linkNotFound);
  });
});

describe("a client's decision", () => {
  it("lands as a review event from the client, pinned to the 9:16 they watched", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16", "4:5"] });
    const { id, token } = await link(h);
    const page = await h.clients.open(token);
    const shown = page.clips[0]?.video?.exportId;

    const view = await h.clients.decide(
      token,
      clip,
      { decision: "approved", name: "Priya", ...(shown === undefined ? {} : { expect: shown }) },
      { ip: "203.0.113.7" },
    );
    expect(view.yourDecision).toMatchObject({
      state: "approved",
      name: "Priya",
      changedSince: false,
    });
    expect(h.db.tables.clipReview[0]).toMatchObject({
      state: "approved",
      actorKind: "client",
      actorUserId: null,
      actorName: "Priya",
      reviewLinkId: id,
      videos: { "9:16": shown },
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "repurpose.clip.review_decided",
      actorKind: "guest",
      ip: "203.0.113.7",
      data: { reviewLinkId: id, name: "Priya" },
    });
    expect(h.audits.at(-1)).not.toHaveProperty("actorId");
    // The team sees it as the client's, covering the 9:16 only.
    const team = await h.reviews.runReview(IDS.ws, IDS.run, OWNER);
    expect(team.clips[0]).toMatchObject({
      state: "approved",
      decidedBy: { kind: "client", name: "Priya", userId: null, link: { id } },
      covered: ["9:16"],
      uncovered: ["4:5"],
    });
    expect(h.notices.at(-1)?.data).toMatchObject({
      verdict: "approved",
      by: "client",
      who: "Priya",
    });
  });

  it("asks for a name when the link says so", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const { token } = await link(h, { requireName: true });
    const denied = await refusal(h.clients.decide(token, clip, { decision: "approved" }));
    expect(denied.code).toBe(REVIEW_ERRORS.nameRequired);
    expect(h.db.tables.clipReview).toEqual([]);
  });

  it("takes changes with a note, as a comment only this link sees", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const first = await link(h);
    const second = await link(h);
    await h.clients.decide(first.token, clip, {
      decision: "changes_requested",
      name: "Priya",
      note: "Please cut the first two seconds",
    });
    expect((await h.clients.open(first.token)).clips[0]?.comments).toMatchObject([
      { name: "Priya", body: "Please cut the first two seconds" },
    ]);
    expect((await h.clients.open(second.token)).clips[0]?.comments).toEqual([]);
    expect(h.notices.at(-1)?.data).toMatchObject({ verdict: "changes" });
  });

  it("refuses a decision on a video that was replaced while they watched", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const { token } = await link(h);
    const shown = (await h.clients.open(token)).clips[0]?.video?.exportId ?? "";
    renderClip(h.db, clip, "9:16");
    const denied = await refusal(
      h.clients.decide(token, clip, { decision: "approved", expect: shown }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.videoChanged);
  });

  it("says when the clip changed after they decided, and it is back in review", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const { token } = await link(h);
    await h.clients.decide(token, clip, { decision: "approved", name: "Priya" });
    renderClip(h.db, clip, "9:16");
    const page = await h.clients.open(token);
    expect(page.clips[0]?.yourDecision).toMatchObject({ state: "approved", changedSince: true });
    expect(h.db.tables.clipReview[0]?.["state"]).toBe("pending");
  });

  it("refuses clips that are not on the page, and too much from one link", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const hidden = seedClip(h.db, 2, { rendered: ["1:1"] });
    const elsewhere = seedClip(h.db, 3, { runId: IDS.otherRun });
    const { token } = await link(h);
    for (const id of [hidden, elsewhere]) {
      expect((await refusal(h.clients.decide(token, id, { decision: "approved" }))).code).toBe(
        REVIEW_ERRORS.clipNotFound,
      );
    }
    h.linkBucket = 0;
    const limited = await refusal(h.clients.comment(token, clip, { body: "Hello" }));
    expect(limited.httpStatus).toBe(429);
  });
});

describe("a client's comment", () => {
  it("is theirs, at a moment in the clip, and tells the run's creator", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const { id, token } = await link(h);
    const comment = await h.clients.comment(token, clip, {
      body: "Love the ending",
      atMs: 21_000,
      name: "Priya",
    });
    expect(comment).toMatchObject({ name: "Priya", body: "Love the ending", atMs: 21_000 });
    expect(h.db.tables.clipComment[0]).toMatchObject({
      authorKind: "client",
      authorUserId: null,
      reviewLinkId: id,
    });
    expect(h.notices[0]?.data).toMatchObject({ verdict: "comment", by: "client" });
    // The team sees it, marked as the client's.
    const detail = await h.reviews.clipReview(IDS.ws, IDS.run, clip, OWNER);
    expect(detail.comments[0]?.author).toMatchObject({ kind: "client", name: "Priya" });
  });

  it("is anonymous when the link does not ask for a name", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const { token } = await link(h);
    await h.clients.comment(token, clip, { body: "Nice" });
    expect(h.notices[0]?.data).toMatchObject({ by: "guest", who: "" });
  });
});
