import { describe, expect, it } from "vitest";

import { IDS, renderClip, reviewHarness, seedClip } from "./review-memory.test-support.js";
import { hashReviewToken } from "./review-token.js";
import { REVIEW_ERRORS } from "./review.constants.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { MemberCaller } from "./clip-review.service.js";

const OWNER: MemberCaller = { userId: IDS.owner, role: "owner" };
const ADMIN: MemberCaller = { userId: IDS.admin, role: "admin" };
const EDITOR: MemberCaller = { userId: IDS.editor, role: "editor" };
const VIEWER: MemberCaller = { userId: IDS.viewer, role: "viewer" };

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("approving and asking for changes", () => {
  it("lets an admin approve, pinned to every shape's current video, and says who and when", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16", "4:5"] });
    const summary = await h.reviews.decideAsMember(IDS.ws, ADMIN, IDS.run, clip, {
      decision: "approved",
    });
    expect(summary).toMatchObject({
      clipId: clip,
      state: "approved",
      decidedBy: { kind: "member", name: "Admin Asha", userId: IDS.admin, link: null },
      decidedAt: "2026-10-03T06:00:00.000Z",
      covered: ["9:16", "4:5"],
      uncovered: [],
    });
    expect(h.db.tables.clipReview[0]).toMatchObject({
      state: "approved",
      version: 1,
      videos: summary.videos,
    });
    expect(h.db.tables.clipReviewEvent).toHaveLength(1);
    expect(h.audits.map((event) => event.action)).toEqual(["repurpose.clip.review_decided"]);
    expect(h.audits[0]).toMatchObject({ actorId: IDS.admin, resourceId: clip });
  });

  it("refuses an editor's approval, but takes their request for changes, note and all", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const denied = await refusal(
      h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, { decision: "approved" }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.forbidden);
    expect(denied.httpStatus).toBe(403);

    const summary = await h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, {
      decision: "changes_requested",
      note: "  The hook cuts off the first word.  ",
    });
    expect(summary.state).toBe("changes_requested");
    // The note is a comment in the thread too, so it can be answered and resolved.
    expect(h.db.tables.clipComment).toHaveLength(1);
    expect(h.db.tables.clipComment[0]).toMatchObject({
      authorKind: "member",
      authorUserId: IDS.editor,
      body: "The hook cuts off the first word.",
    });
    expect(h.db.tables.clipReviewEvent[0]).toMatchObject({
      note: "The hook cuts off the first word.",
    });
  });

  it("refuses a viewer's request for changes", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const denied = await refusal(
      h.reviews.decideAsMember(IDS.ws, VIEWER, IDS.run, clip, { decision: "changes_requested" }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.forbidden);
  });

  it("needs a finished captioned video to approve", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1, { rendered: [] });
    const denied = await refusal(
      h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.noVideo);
    expect(denied.httpStatus).toBe(409);
    expect(h.db.tables.clipReview).toEqual([]);
  });

  it("refuses to pin a decision to videos the page did not show", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const shown = (await h.reviews.runReview(IDS.ws, IDS.run, OWNER)).clips[0]?.videos ?? {};
    renderClip(h.db, clip, "9:16");
    const denied = await refusal(
      h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, {
        decision: "approved",
        expect: shown,
      }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.videoChanged);
    expect(h.db.tables.clipReview).toEqual([]);
  });

  it("records a double tap once", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    expect(h.db.tables.clipReviewEvent).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("lets an editor pull an approval back by asking for changes", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    const summary = await h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, {
      decision: "changes_requested",
    });
    expect(summary.state).toBe("changes_requested");
    expect(h.db.tables.clipReview[0]?.["version"]).toBe(2);
  });

  it("answers 404 for a clip of another run, a removed moment, another workspace, or the surface off", async () => {
    const h = reviewHarness();
    const removed = seedClip(h.db, 1, { removed: true });
    const elsewhere = seedClip(h.db, 2, { runId: IDS.otherRun });
    for (const clip of [removed, elsewhere, "01JNOPE0000000000000000000"]) {
      const denied = await refusal(
        h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" }),
      );
      expect(denied.httpStatus, clip).toBe(404);
    }
    const kept = seedClip(h.db, 3);
    expect(
      (
        await refusal(
          h.reviews.decideAsMember(IDS.otherWs, OWNER, IDS.run, kept, {
            decision: "approved",
          }),
        )
      ).httpStatus,
    ).toBe(404);
    const off = reviewHarness({ flags: { repurpose_flow: false } });
    expect((await refusal(off.reviews.runReview(IDS.ws, IDS.run, OWNER))).httpStatus).toBe(404);
  });
});

describe("two decisions at the same moment", () => {
  it("reads again and retries when another decision won the compare-and-set", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    // Someone else's decision lands between this read and this write.
    h.db.beforeTransaction = () => {
      const row = h.db.tables.clipReview[0];
      if (row !== undefined) row["version"] = (row["version"] as number) + 1;
    };
    const summary = await h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, {
      decision: "changes_requested",
    });
    expect(summary.state).toBe("changes_requested");
    // The lost attempt wrote nothing; the retry wrote once.
    expect(h.db.tables.clipReviewEvent).toHaveLength(2);
  });

  it("retries a first decision that raced another first decision", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    h.db.beforeTransaction = () => {
      h.db.tables.clipReview.push({
        clipId: clip,
        runId: IDS.run,
        workspaceId: IDS.ws,
        state: "changes_requested",
        actorKind: "member",
        actorUserId: IDS.editor,
        actorName: null,
        reviewLinkId: null,
        videos: {},
        version: 1,
        decidedAt: new Date(),
      });
    };
    const summary = await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, {
      decision: "approved",
    });
    expect(summary.state).toBe("approved");
    expect(h.db.tables.clipReview).toHaveLength(1);
    expect(h.db.tables.clipReview[0]?.["version"]).toBe(2);
  });
});

describe("back to pending when the clip is edited", () => {
  it("returns an approved clip to pending once a new captioned video replaces the approved one", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16", "1:1"] });
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    renderClip(h.db, clip, "1:1");

    const view = await h.reviews.runReview(IDS.ws, IDS.run, OWNER);
    expect(view.clips[0]).toMatchObject({
      state: "pending",
      reason: "video_changed",
      decidedBy: { kind: "system" },
      covered: [],
    });
    expect(h.db.tables.clipReviewEvent.at(-1)).toMatchObject({
      state: "pending",
      actorKind: "system",
      reason: "video_changed",
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "repurpose.clip.review_reopened",
      actorKind: "system",
      data: { was: "approved", shapes: ["1:1"] },
    });
  });

  it("returns a clip with changes requested to pending too: the changes have landed", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, {
      decision: "changes_requested",
    });
    renderClip(h.db, clip, "9:16");
    await h.reviews.sync(IDS.ws, [clip]);
    expect(h.db.tables.clipReview[0]?.["state"]).toBe("pending");
  });

  it("does it from the finished export itself, without waiting for a read", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    const fresh = renderClip(h.db, clip, "9:16");
    await h.reviews.syncForExport(IDS.ws, fresh);
    expect(h.db.tables.clipReview[0]?.["state"]).toBe("pending");
    // Another workspace's export id finds nothing and changes nothing.
    await h.reviews.syncForExport(IDS.otherWs, fresh);
  });

  it("keeps an approval when only a shape made after it lands, and reports it uncovered", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16"] });
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    renderClip(h.db, clip, "16:9");
    const view = await h.reviews.runReview(IDS.ws, IDS.run, OWNER);
    expect(view.clips[0]).toMatchObject({
      state: "approved",
      covered: ["9:16"],
      uncovered: ["16:9"],
    });
  });

  it("lets a decision that lands at the same moment stand over the return to pending", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, clip, { decision: "approved" });
    renderClip(h.db, clip, "9:16");
    h.db.beforeTransaction = () => {
      const row = h.db.tables.clipReview[0];
      if (row !== undefined) row["version"] = (row["version"] as number) + 1;
    };
    await h.reviews.sync(IDS.ws, [clip]);
    expect(h.db.tables.clipReview[0]?.["state"]).toBe("approved");
    expect(h.db.tables.clipReviewEvent).toHaveLength(1);
  });
});

describe("the run's review", () => {
  it("lists every listed clip, the setting and the caller's permissions", async () => {
    const h = reviewHarness({ settings: { clipsNeedApproval: true } });
    const one = seedClip(h.db, 1);
    seedClip(h.db, 2, { removed: true });
    const three = seedClip(h.db, 3, { rendered: [] });
    const view = await h.reviews.runReview(IDS.ws, IDS.run, VIEWER);
    expect(view.needsApproval).toBe(true);
    expect(view.permissions).toMatchObject({ approve: false, comment: true });
    expect(view.clips.map((clip) => [clip.clipId, clip.state])).toEqual([
      [one, "pending"],
      [three, "pending"],
    ]);
    expect(view.clips[0]?.video).toMatchObject({ shape: "9:16" });
    expect(view.clips[0]?.video?.url).toContain("X-Amz-Expires=3600");
    expect(view.clips[1]?.video).toBeNull();
  });

  it("counts comments, and open ones apart", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const first = await h.reviews.addMemberComment(IDS.ws, VIEWER, IDS.run, clip, {
      body: "Love this one",
    });
    h.setNow(Date.parse("2026-10-03T06:01:00Z"));
    await h.reviews.addMemberComment(IDS.ws, EDITOR, IDS.run, clip, {
      body: "Trim the end",
      atMs: 12_500,
    });
    await h.reviews.resolveComment(IDS.ws, VIEWER, IDS.run, clip, first.id, true);
    const view = await h.reviews.runReview(IDS.ws, IDS.run, OWNER);
    expect(view.clips[0]?.comments).toEqual({ total: 2, open: 1 });

    const detail = await h.reviews.clipReview(IDS.ws, IDS.run, clip, VIEWER);
    expect(
      detail.comments.map((comment) => [comment.body, comment.atMs, comment.canResolve]),
    ).toEqual([
      ["Love this one", null, true],
      ["Trim the end", 12_500, false],
    ]);
    expect(detail.comments[0]?.author).toMatchObject({ kind: "member", name: "viewer" });
  });
});

describe("comments", () => {
  it("lets a viewer comment and resolve their own, but not someone else's", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const theirs = await h.reviews.addMemberComment(IDS.ws, EDITOR, IDS.run, clip, {
      body: "Needs a stronger hook",
    });
    const denied = await refusal(
      h.reviews.resolveComment(IDS.ws, VIEWER, IDS.run, clip, theirs.id, true),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.forbidden);
    const resolved = await h.reviews.resolveComment(IDS.ws, EDITOR, IDS.run, clip, theirs.id, true);
    expect(resolved.resolvedAt).toBe("2026-10-03T06:00:00.000Z");
    expect(h.audits.map((event) => event.action)).toEqual([
      "repurpose.clip.comment_added",
      "repurpose.clip.comment_resolved",
    ]);
    const reopened = await h.reviews.resolveComment(
      IDS.ws,
      EDITOR,
      IDS.run,
      clip,
      theirs.id,
      false,
    );
    expect(reopened.resolvedAt).toBeNull();
  });

  it("answers 404 for a comment on another clip", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const other = seedClip(h.db, 2);
    const comment = await h.reviews.addMemberComment(IDS.ws, EDITOR, IDS.run, clip, { body: "Hi" });
    const denied = await refusal(
      h.reviews.resolveComment(IDS.ws, EDITOR, IDS.run, other, comment.id, true),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.commentNotFound);
  });
});

describe("telling the run's creator", () => {
  it("sends clip-review to the person who started the run, in their language, with the verdict", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, ADMIN, IDS.run, clip, { decision: "approved" });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      kind: "clip-review",
      to: "editor@example.test",
      userId: IDS.editor,
      locale: "en-IN",
      workspaceId: IDS.ws,
      data: {
        verdict: "approved",
        by: "member",
        who: "Admin Asha",
        clip: "Clip 1",
        video: "Diwali vlog",
        runId: IDS.run,
        clipId: clip,
        link: `https://aksharo.test/repurpose/${IDS.run}#clip-${clip}`,
      },
    });
  });

  it("never tells them about their own decision", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, EDITOR, IDS.run, clip, {
      decision: "changes_requested",
    });
    expect(h.notices).toEqual([]);
  });

  it("goes to the owner once the creator has left the workspace", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const membership = h.db.tables.membership.find((row) => row["userId"] === IDS.editor);
    if (membership !== undefined) membership["status"] = "removed";
    await h.reviews.decideAsMember(IDS.ws, ADMIN, IDS.run, clip, { decision: "approved" });
    expect(h.notices[0]).toMatchObject({ to: "owner@example.test", userId: IDS.owner });
  });

  it("groups one clip's comments: one notification per ten minutes", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    const other = seedClip(h.db, 2);
    for (const body of ["One", "Two", "Three"]) {
      await h.reviews.addMemberComment(IDS.ws, VIEWER, IDS.run, clip, { body });
    }
    await h.reviews.addMemberComment(IDS.ws, VIEWER, IDS.run, other, { body: "Elsewhere" });
    expect(h.notices.map((notice) => notice.data?.["clipId"])).toEqual([clip, other]);
    h.setNow(Date.parse("2026-10-03T06:11:00Z"));
    await h.reviews.addMemberComment(IDS.ws, VIEWER, IDS.run, clip, { body: "Later" });
    expect(h.notices).toHaveLength(3);
  });

  it("tells them when a clip is back in review, as Aksharo", async () => {
    const h = reviewHarness();
    const clip = seedClip(h.db, 1);
    await h.reviews.decideAsMember(IDS.ws, ADMIN, IDS.run, clip, { decision: "approved" });
    renderClip(h.db, clip, "9:16");
    await h.reviews.sync(IDS.ws, [clip]);
    expect(h.notices.at(-1)?.data).toMatchObject({ verdict: "reopened", by: "system" });
  });
});

describe("client links", () => {
  it("stores a hash of the token and shows the link once", async () => {
    const h = reviewHarness();
    const created = await h.reviews.createLink(IDS.ws, ADMIN, IDS.run, {
      expiresInDays: 3,
      requireName: true,
      label: "For Priya",
    });
    const token = created.url.split("/").at(-1) ?? "";
    expect(created.url).toBe(`https://aksharo.test/share/review/${token}`);
    expect(created).toMatchObject({
      status: "live",
      requireName: true,
      label: "For Priya",
      hint: token.slice(-4),
      expiresAt: "2026-10-06T06:00:00.000Z",
    });
    const row = h.db.tables.clipReviewLink[0];
    expect(row?.["tokenHash"]).toBe(hashReviewToken(token));
    expect(JSON.stringify(h.db.tables.clipReviewLink)).not.toContain(token);
    expect(JSON.stringify(h.audits)).not.toContain(token);
    // The list never carries the link again.
    const [listed] = await h.reviews.listLinks(IDS.ws, IDS.run);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed).not.toHaveProperty("url");
  });

  it("refuses a link while public links are off, and past twenty live ones", async () => {
    const off = reviewHarness({ publicShares: false });
    expect(
      (
        await refusal(
          off.reviews.createLink(IDS.ws, ADMIN, IDS.run, { expiresInDays: 7, requireName: false }),
        )
      ).httpStatus,
    ).toBe(404);

    const h = reviewHarness();
    for (let n = 0; n < 20; n += 1) {
      await h.reviews.createLink(IDS.ws, ADMIN, IDS.run, { expiresInDays: 7, requireName: false });
    }
    const denied = await refusal(
      h.reviews.createLink(IDS.ws, ADMIN, IDS.run, { expiresInDays: 7, requireName: false }),
    );
    expect(denied.code).toBe(REVIEW_ERRORS.tooManyLinks);
  });

  it("revokes, once, with an audit row", async () => {
    const h = reviewHarness();
    const created = await h.reviews.createLink(IDS.ws, ADMIN, IDS.run, {
      expiresInDays: 7,
      requireName: false,
    });
    const revoked = await h.reviews.revokeLink(IDS.ws, EDITOR, IDS.run, created.id);
    expect(revoked.status).toBe("revoked");
    await h.reviews.revokeLink(IDS.ws, EDITOR, IDS.run, created.id);
    expect(h.audits.map((event) => event.action)).toEqual([
      "repurpose.review_link.created",
      "repurpose.review_link.revoked",
    ]);
    expect(
      (await refusal(h.reviews.revokeLink(IDS.ws, EDITOR, IDS.otherRun, created.id))).httpStatus,
    ).toBe(404);
  });

  it("reads an expired link as expired", async () => {
    const h = reviewHarness();
    await h.reviews.createLink(IDS.ws, ADMIN, IDS.run, { expiresInDays: 1, requireName: false });
    h.setNow(Date.parse("2026-10-04T06:00:01Z"));
    const [link] = await h.reviews.listLinks(IDS.ws, IDS.run);
    expect(link?.status).toBe("expired");
  });
});
