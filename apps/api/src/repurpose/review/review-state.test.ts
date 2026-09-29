import { describe, expect, it } from "vitest";

import type { VideoShape } from "@montaj/repurpose-contracts";

import {
  APPROVAL_MESSAGES,
  NOT_REQUIRED,
  approvalCheck,
  coveredShapes,
  decide,
  mayDecide,
  mayPost,
  mayResolve,
  pinVideos,
  pinnedShapes,
  pinsOf,
  reopenedBy,
  replacedShapes,
  reviewPermissions,
  samePins,
  uncoveredShapes,
  type StoredReview,
} from "./review-state.js";

const videos = (entries: Record<string, string>): Map<VideoShape, { exportId: string }> =>
  new Map(Object.entries(entries).map(([shape, exportId]) => [shape as VideoShape, { exportId }]));

const MEMBER = { kind: "member", userId: "U1" } as const;
const CLIENT = { kind: "client", linkId: "L1", name: "Priya" } as const;

function stored(over: Partial<StoredReview> = {}): StoredReview {
  return {
    state: "approved",
    actorKind: "member",
    actorUserId: "U1",
    reviewLinkId: null,
    actorName: null,
    videos: { "9:16": "E1" },
    ...over,
  };
}

describe("video pins", () => {
  it("pins each shape's video, or only the shapes a reviewer saw", () => {
    const all = videos({ "9:16": "E1", "1:1": "E3", "4:5": "E2" });
    expect(pinVideos(all)).toEqual({ "9:16": "E1", "4:5": "E2", "1:1": "E3" });
    expect(pinVideos(all, ["9:16"])).toEqual({ "9:16": "E1" });
    expect(pinVideos(new Map())).toEqual({});
  });

  it("reads a stored column defensively: anything unreadable is no pins", () => {
    expect(pinsOf({ "9:16": "E1" })).toEqual({ "9:16": "E1" });
    expect(pinsOf(null)).toEqual({});
    expect(pinsOf("9:16")).toEqual({});
    expect(pinsOf({ "3:2": "E1" })).toEqual({});
    expect(pinnedShapes({ "16:9": "E4", "9:16": "E1" })).toEqual(["9:16", "16:9"]);
  });

  it("compares pins shape by shape", () => {
    expect(samePins({ "9:16": "E1" }, { "9:16": "E1" })).toBe(true);
    expect(samePins({ "9:16": "E1" }, { "9:16": "E2" })).toBe(false);
    expect(samePins({ "9:16": "E1" }, { "9:16": "E1", "4:5": "E2" })).toBe(false);
  });

  it("tells replaced, covered and uncovered shapes apart", () => {
    const pins = { "9:16": "E1", "4:5": "E2" };
    const now = videos({ "9:16": "E1", "4:5": "E9", "1:1": "E3" });
    expect(replacedShapes(pins, now)).toEqual(["4:5"]);
    expect(coveredShapes(pins, now)).toEqual(["9:16"]);
    expect(uncoveredShapes(pins, now)).toEqual(["1:1"]);
  });
});

describe("back to pending when the video changes", () => {
  it("reopens an approval or a request for changes when a pinned shape has a new video", () => {
    const now = videos({ "9:16": "E2" });
    expect(reopenedBy({ state: "approved", videos: { "9:16": "E1" } }, now)).toEqual(["9:16"]);
    expect(reopenedBy({ state: "changes_requested", videos: { "9:16": "E1" } }, now)).toEqual([
      "9:16",
    ]);
  });

  it("leaves a decision alone while its videos are the current ones", () => {
    expect(
      reopenedBy({ state: "approved", videos: { "9:16": "E1" } }, videos({ "9:16": "E1" })),
    ).toBeNull();
  });

  it("does not count a shape made after the decision as a change to it", () => {
    expect(
      reopenedBy(
        { state: "approved", videos: { "9:16": "E1" } },
        videos({ "9:16": "E1", "16:9": "E4" }),
      ),
    ).toBeNull();
  });

  it("does not count a video that is simply gone (its file expired) as a new one", () => {
    expect(reopenedBy({ state: "approved", videos: { "9:16": "E1" } }, new Map())).toBeNull();
  });

  it("has nothing to reopen while pending or never reviewed", () => {
    expect(reopenedBy(null, videos({ "9:16": "E2" }))).toBeNull();
    expect(reopenedBy({ state: "pending", videos: {} }, videos({ "9:16": "E2" }))).toBeNull();
  });
});

describe("who may do what", () => {
  it.each([
    [
      "owner",
      {
        approve: true,
        requestChanges: true,
        comment: true,
        resolveAny: true,
        shareLinks: true,
        revokeLinks: true,
      },
    ],
    [
      "admin",
      {
        approve: true,
        requestChanges: true,
        comment: true,
        resolveAny: true,
        shareLinks: true,
        revokeLinks: true,
      },
    ],
    [
      "editor",
      {
        approve: false,
        requestChanges: true,
        comment: true,
        resolveAny: true,
        shareLinks: false,
        revokeLinks: true,
      },
    ],
    [
      "viewer",
      {
        approve: false,
        requestChanges: false,
        comment: true,
        resolveAny: false,
        shareLinks: false,
        revokeLinks: false,
      },
    ],
  ] as const)("%s", (role, expected) => {
    expect(reviewPermissions(role)).toEqual(expected);
  });

  it("approves as owner or admin only, and asks for changes as an editor and up", () => {
    expect(mayDecide("admin", "approved")).toBe(true);
    expect(mayDecide("editor", "approved")).toBe(false);
    expect(mayDecide("editor", "changes_requested")).toBe(true);
    expect(mayDecide("viewer", "changes_requested")).toBe(false);
  });

  it("lets a viewer resolve their own comment, and an editor anyone's - never a client's for a viewer", () => {
    const own = { authorKind: "member", authorUserId: "V1" } as const;
    const other = { authorKind: "member", authorUserId: "U9" } as const;
    const client = { authorKind: "client", authorUserId: null } as const;
    expect(mayResolve("viewer", own, "V1")).toBe(true);
    expect(mayResolve("viewer", other, "V1")).toBe(false);
    expect(mayResolve("viewer", client, "V1")).toBe(false);
    expect(mayResolve("editor", client, "E1")).toBe(true);
  });
});

describe("a decision", () => {
  it("needs a video to approve, but not to ask for changes", () => {
    expect(decide(null, { decision: "approved", actor: MEMBER, videos: {} })).toEqual({
      kind: "no_video",
    });
    expect(decide(null, { decision: "changes_requested", actor: MEMBER, videos: {} })).toEqual({
      kind: "write",
      state: "changes_requested",
      videos: {},
    });
  });

  it("is one event when the same person repeats it on the same videos", () => {
    expect(
      decide(stored(), { decision: "approved", actor: MEMBER, videos: { "9:16": "E1" } }),
    ).toEqual({ kind: "unchanged" });
  });

  it("is written again for new videos, another person, a client, or something more to say", () => {
    const write = { kind: "write", state: "approved" };
    expect(
      decide(stored(), {
        decision: "approved",
        actor: MEMBER,
        videos: { "9:16": "E1", "1:1": "E3" },
      }),
    ).toMatchObject(write);
    expect(
      decide(stored(), {
        decision: "approved",
        actor: { kind: "member", userId: "U2" },
        videos: { "9:16": "E1" },
      }),
    ).toMatchObject(write);
    expect(
      decide(stored(), { decision: "approved", actor: CLIENT, videos: { "9:16": "E1" } }),
    ).toMatchObject(write);
    expect(
      decide(stored({ state: "changes_requested" }), {
        decision: "changes_requested",
        actor: MEMBER,
        videos: { "9:16": "E1" },
        note: "Trim the first second",
      }),
    ).toMatchObject({ kind: "write", state: "changes_requested" });
  });

  it("tells one client from another by link and name", () => {
    const client = stored({
      actorKind: "client",
      actorUserId: null,
      reviewLinkId: "L1",
      actorName: "Priya",
    });
    expect(
      decide(client, { decision: "approved", actor: CLIENT, videos: { "9:16": "E1" } }),
    ).toEqual({ kind: "unchanged" });
    expect(
      decide(client, {
        decision: "approved",
        actor: { kind: "client", linkId: "L2", name: "Priya" },
        videos: { "9:16": "E1" },
      }),
    ).toMatchObject({ kind: "write" });
  });
});

describe("posting under the approval rule", () => {
  it("needs nothing while the workspace does not ask for approval", () => {
    expect(approvalCheck(false, null)).toBe(NOT_REQUIRED);
    expect(mayPost(NOT_REQUIRED, "anything")).toBe(true);
  });

  it("refuses a clip that is pending or has changes requested, and says which", () => {
    expect(approvalCheck(true, null)).toMatchObject({
      required: true,
      state: "pending",
      message: APPROVAL_MESSAGES.pending,
    });
    const changes = approvalCheck(true, { state: "changes_requested", videos: { "9:16": "E1" } });
    expect(changes.message).toBe(APPROVAL_MESSAGES.changes_requested);
    expect(mayPost(changes, "E1")).toBe(false);
  });

  it("posts only the videos an approval pinned", () => {
    const check = approvalCheck(true, { state: "approved", videos: { "9:16": "E1" } });
    expect(check.message).toBeNull();
    expect(mayPost(check, "E1")).toBe(true);
    expect(mayPost(check, "E2")).toBe(false);
  });
});
