import { describe, expect, it } from "vitest";

import {
  IDS,
  cleanCut,
  guestHarness,
  renderClip,
  seedClip,
  seedDub,
  storeEpisodePack,
  storeImages,
  tokenOf,
  type GuestHarness,
} from "./guest-memory.test-support.js";
import { GUEST_ERRORS, GUEST_URL_TTL_SECONDS } from "./guest.constants.js";
import { createGuestLinkSchema, type CreateGuestLinkInput } from "./guest.dto.js";
import { AppException } from "../../common/errors/error-codes.js";
import { REVIEW_ERRORS } from "../review/review.constants.js";

import type { MemberCaller } from "../review/clip-review.service.js";

const EDITOR: MemberCaller = { userId: IDS.editor, role: "editor" };
const OWNER: MemberCaller = { userId: IDS.owner, role: "owner" };

const COPY = {
  summary: "Why most people never save",
  hook: "Stop doing this",
  cta: "",
  hashtags: ["#money"],
  locale: "en",
  title: "Never save",
  description: "The one habit.",
  platforms: { instagram: { caption: "The one habit. #money" } },
};

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A link as the team makes it; answers its id and the token its address carries. */
async function share(
  h: GuestHarness,
  over: Partial<CreateGuestLinkInput> = {},
): Promise<{ id: string; token: string }> {
  const created = await h.links.createLink(IDS.ws, EDITOR, IDS.run, {
    ...createGuestLinkSchema.parse({ allClips: true }),
    ...over,
  });
  return { id: created.id, token: tokenOf(created.url) };
}

describe("a guest's page", () => {
  it("greets the guest and offers each shared clip's files and words, in video order", async () => {
    const h = guestHarness();
    const late = seedClip(h.db, 1, { startMs: 600_000, rendered: ["9:16", "4:5"], copy: COPY });
    cleanCut(h.db, late, "9:16");
    const early = seedClip(h.db, 2, { startMs: 60_000 });
    const { token } = await share(h, { guestName: "Priya" });

    const page = await h.pages.open(token);
    expect(page).toMatchObject({
      title: "Diwali vlog",
      guestName: "Priya",
      expiresAt: "2026-10-19T06:00:00.000Z",
      comingSoon: 0,
      episode: null,
    });
    expect(page.clips.map((clip) => clip.id)).toEqual([early, late]);
    const clip = page.clips[1];
    expect(clip).toMatchObject({
      title: "Clip 1",
      hashtags: ["#money"],
      posts: [
        { platform: "any", title: "Never save", text: "The one habit.\n\n#money" },
        { platform: "instagram", title: null, text: "The one habit. #money" },
      ],
    });
    expect(clip?.videos.map((video) => [video.shape, video.width, video.height])).toEqual([
      ["9:16", 1080, 1920],
      ["4:5", 1080, 1350],
    ]);
    // Downloads carry the file's name; the player is signed for viewing.
    expect(clip?.videos[0]?.url).toContain("response-content-disposition");
    expect(clip?.videos[0]?.cleanUrl).toContain(encodeURIComponent("Clip 1 9x16 no captions.mp4"));
    expect(clip?.videos[1]?.cleanUrl).toBeNull();
    expect(clip?.player).toMatchObject({ shape: "9:16", captioned: true, posterUrl: null });
    expect(clip?.player?.url).not.toContain("response-content-disposition");
    expect(h.signed.map((entry) => entry.filename).filter(Boolean)).toEqual(
      expect.arrayContaining(["Clip 1 9x16.mp4", "Clip 1 4x5.mp4", "Clip 1 9x16 no captions.mp4"]),
    );
  });

  it("signs every file afresh on each view, for twenty minutes, and never a key of another workspace", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16", "1:1"] });
    // A row pointing outside the workspace's own folder is never signed.
    const foreign = h.db.tables.export.find((row) => String(row["id"]).endsWith("r1x1"));
    if (foreign !== undefined) foreign["storageKey"] = `ws/${IDS.otherWs}/p/X/exports/stolen.mp4`;
    const { token } = await share(h);

    const page = await h.pages.open(token);
    expect(page.clips[0]?.videos.map((video) => video.shape)).toEqual(["9:16"]);
    expect(h.signed.every((entry) => entry.ttl === GUEST_URL_TTL_SECONDS)).toBe(true);
    expect(GUEST_URL_TTL_SECONDS).toBe(20 * 60);
    expect(h.signed.some((entry) => entry.key.includes(IDS.otherWs))).toBe(false);
    const before = h.signed.length;
    await h.pages.open(token);
    expect(h.signed.length).toBe(before * 2);
    expect(clip).toBeDefined();
  });

  it("shows only the clips the link shares: never another run's, never one removed", async () => {
    const h = guestHarness();
    const one = seedClip(h.db, 1);
    const two = seedClip(h.db, 2);
    const removed = seedClip(h.db, 3);
    const elsewhere = seedClip(h.db, 4, { runId: IDS.otherRun });
    const { token, id } = await share(h, { allClips: false, clipIds: [two, removed] });
    // Even a link row naming another run's clip reaches only its own run.
    const row = h.db.tables.clipGuestLink.find((entry) => entry["id"] === id);
    if (row !== undefined) row["clipIds"] = [two, removed, elsewhere];
    const candidate = h.db.tables.clipCandidate.find((entry) => String(entry["id"]).endsWith("C3"));
    if (candidate !== undefined) candidate["state"] = "rejected";

    const page = await h.pages.open(token);
    expect(page.clips.map((clip) => clip.id)).toEqual([two]);
    const json = JSON.stringify(page);
    for (const hidden of [one, removed, elsewhere]) expect(json).not.toContain(hidden);

    // Every clip of the run, when the link shares them all - clips made later too.
    const all = await share(h);
    const five = seedClip(h.db, 5);
    expect((await h.pages.open(all.token)).clips.map((clip) => clip.id)).toEqual([one, two, five]);
  });

  it("says nothing of the workspace, its people, reviews or storage", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1, { rendered: ["9:16"] });
    await h.reviews.addMemberComment(IDS.ws, OWNER, IDS.run, clip, { body: "Internal note" });
    const { token } = await share(h);
    const page = await h.pages.open(token);
    const json = JSON.stringify(page);
    for (const secret of [
      IDS.owner,
      IDS.admin,
      IDS.editor,
      "Internal note",
      "storageKey",
      "tokenHash",
      "workspaceId",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(Object.keys(page).sort()).toEqual([
      "clips",
      "comingSoon",
      "episode",
      "expiresAt",
      "guestName",
      "title",
    ]);
  });

  it("counts a shared clip with nothing to download yet as coming", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    seedClip(h.db, 2, { rendered: [] });
    const { token } = await share(h);
    const page = await h.pages.open(token);
    expect(page.clips).toHaveLength(1);
    expect(page.comingSoon).toBe(1);
  });

  it("offers the clean cut alone when a clip has no captioned video", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1, { rendered: [] });
    cleanCut(h.db, clip, "9:16");
    // A cut still being written is no file yet.
    cleanCut(h.db, clip, "1:1", { status: "pending" });
    const { token } = await share(h);
    const [shown] = (await h.pages.open(token)).clips;
    expect(shown?.videos).toEqual([
      expect.objectContaining({ shape: "9:16", url: null, cleanUrl: expect.any(String) }),
    ]);
    expect(shown?.player).toMatchObject({ shape: "9:16", captioned: false });
  });

  it("offers the images, with the vertical still before the video plays", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1);
    storeImages(h.db, clip, "9:16:EXP");
    const { token } = await share(h);
    const [shown] = (await h.pages.open(token)).clips;
    expect(shown?.images.map((image) => [image.id, image.urls.length])).toEqual([
      ["carousel", 2],
      ["vertical-image", 1],
      ["thumbnail", 1],
    ]);
    expect(shown?.player?.posterUrl).toContain("vertical-image-1.jpg");
    expect(h.signed.map((entry) => entry.filename)).toContain("Clip 1 carousel-2.jpg");
  });

  it("adds the dubbed versions only when the link includes them", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1);
    seedDub(h.db, clip, { languages: ["hi-IN", "ta-IN"], shapes: ["9:16", "1:1"] });
    seedDub(h.db, clip, { languages: ["bn-IN"], status: "failed" });
    seedDub(h.db, clip, { languages: ["mr-IN"], status: "dubbing" });
    seedDub(h.db, clip, { languages: ["te-IN"], runId: IDS.otherRun });

    const without = await share(h);
    expect((await h.pages.open(without.token)).clips[0]?.dubs).toEqual([]);

    const withDubs = await share(h, { includeDubs: true });
    const dubs = (await h.pages.open(withDubs.token)).clips[0]?.dubs ?? [];
    expect(dubs.map((dub) => [dub.language, dub.name, dub.videos.map((v) => v.shape)])).toEqual([
      ["hi-IN", "Hindi", ["9:16", "1:1"]],
      ["ta-IN", "Tamil", ["9:16", "1:1"]],
    ]);
    expect(dubs[0]?.videos[0]).toMatchObject({
      url: expect.stringContaining("DEXP.mp4"),
      cleanUrl: expect.stringContaining("dubbed.mp4"),
    });
    expect(h.signed.map((entry) => entry.filename)).toContain("Clip 1 9x16 Hindi.mp4");
  });

  it("offers a newer dub of a language over an older one", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1);
    seedDub(h.db, clip, { languages: ["hi-IN"] });
    const newer = seedDub(h.db, clip, { languages: ["hi-IN"], shapes: ["4:5"] });
    const { token } = await share(h, { includeDubs: true });
    const dubs = (await h.pages.open(token)).clips[0]?.dubs ?? [];
    expect(dubs).toHaveLength(1);
    expect(dubs[0]?.videos.map((video) => video.shape)).toEqual(["4:5"]);
    expect(dubs[0]?.videos[0]?.url).toContain(newer);
  });

  it("adds the episode's own posts when its text was written", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    storeEpisodePack(h.db, {
      chapters: [],
      youtubeDescription: "Full episode",
      showNotes: "Notes",
      linkedinPost: "  What we talked about  ",
      xThread: ["1/ We talked", " ", "2/ About saving"],
      newsletter: "Draft",
    });
    const { token } = await share(h);
    expect((await h.pages.open(token)).episode).toEqual({
      linkedin: "What we talked about",
      xThread: ["1/ We talked", "2/ About saving"],
    });
  });
});

describe("a guest's page when clips need approval before posting", () => {
  it("offers only approved clips, and only the videos the approval covers", async () => {
    const h = guestHarness({ settings: { clipsNeedApproval: true } });
    const approved = seedClip(h.db, 1, { rendered: ["9:16", "4:5"] });
    seedClip(h.db, 2);
    await h.reviews.decideAsMember(IDS.ws, OWNER, IDS.run, approved, { decision: "approved" });
    // A new 4:5 video, made after the approval: not what was approved.
    renderClip(h.db, approved, "4:5");
    const { token } = await share(h);

    const page = await h.pages.open(token);
    expect(page.clips.map((clip) => clip.id)).toEqual([approved]);
    expect(page.clips[0]?.videos.map((video) => video.shape)).toEqual(["9:16"]);
    expect(page.comingSoon).toBe(1);
  });
});

describe("a guest link's token", () => {
  it("answers 404 for an unknown or malformed token, and 410 once revoked or expired", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const { id, token } = await share(h, { expiresInDays: 1 });
    expect((await refusal(h.pages.open("A".repeat(24)))).code).toBe(GUEST_ERRORS.linkNotFound);
    expect((await refusal(h.pages.open("not a token"))).httpStatus).toBe(404);
    expect((await refusal(h.pages.open(""))).httpStatus).toBe(404);

    h.setNow(Date.parse("2026-10-06T06:00:00Z"));
    const expired = await refusal(h.pages.open(token));
    expect(expired.code).toBe(GUEST_ERRORS.linkExpired);
    expect(expired.httpStatus).toBe(410);

    h.setNow(Date.parse("2026-10-05T07:00:00Z"));
    await h.links.revokeLink(IDS.ws, EDITOR, IDS.run, id);
    const revoked = await refusal(h.pages.open(token));
    expect(revoked.code).toBe(GUEST_ERRORS.linkRevoked);
    expect(revoked.httpStatus).toBe(410);
  });

  it("is only ever a guest link: a review page does not open it, nor it a review link", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const { token } = await share(h);
    const review = await h.reviews.createLink(IDS.ws, OWNER, IDS.run, {
      expiresInDays: 7,
      requireName: false,
    });
    const reviewToken = tokenOf(review.url);
    expect((await refusal(h.pages.open(reviewToken))).code).toBe(GUEST_ERRORS.linkNotFound);
    const reviewTable = h.db.tables.clipReviewLink.map((row) => row["tokenHash"]);
    const guestTable = h.db.tables.clipGuestLink.map((row) => row["tokenHash"]);
    expect(reviewTable.some((hash) => guestTable.includes(hash))).toBe(false);
    expect(REVIEW_ERRORS.linkNotFound).not.toBe(GUEST_ERRORS.linkNotFound);
    expect(token).not.toBe(reviewToken);
  });

  it("reaches nothing once the workspace is deleted or its clips surface is off", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const { token } = await share(h);
    const off = h.reviews as unknown as { assertAvailable: () => Promise<void> };
    const real = off.assertAvailable;
    off.assertAvailable = async () => {
      throw new Error("off");
    };
    expect((await refusal(h.pages.open(token))).code).toBe(GUEST_ERRORS.linkNotFound);
    off.assertAvailable = real;

    const workspace = h.db.tables.workspace[0];
    if (workspace !== undefined) workspace["deletedAt"] = new Date();
    expect((await refusal(h.pages.open(token))).code).toBe(GUEST_ERRORS.linkNotFound);
  });

  it("counts a visit per half hour, not per refresh", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const { token } = await share(h);
    await h.pages.open(token);
    await h.pages.open(token);
    h.setNow(Date.parse("2026-10-05T06:31:00Z"));
    await h.pages.open(token);
    expect(h.db.tables.clipGuestLink[0]).toMatchObject({ viewCount: 2 });
  });
});

describe("a download from a guest's page", () => {
  it("is counted on the link and audited as the guest's", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1);
    const { id, token } = await share(h);
    h.audits.length = 0;
    await h.pages.countDownload(
      token,
      { clipId: clip, file: "video", shape: "9:16" },
      { ip: "203.0.113.7" },
    );
    await h.pages.countDownload(token, { clipId: clip, file: "image", image: "carousel" });
    expect(h.db.tables.clipGuestLink[0]).toMatchObject({
      downloadCount: 2,
      lastDownloadedAt: new Date("2026-10-05T06:00:00Z"),
    });
    expect(h.audits[0]).toMatchObject({
      action: "repurpose.guest_link.downloaded",
      resource: "clip_guest_link",
      resourceId: id,
      actorKind: "guest",
      workspaceId: IDS.ws,
      ip: "203.0.113.7",
      data: { runId: IDS.run, clipId: clip, file: "video", shape: "9:16" },
    });
    expect(h.audits[0]).not.toHaveProperty("actorId");
    const listed = await h.links.listLinks(IDS.ws, IDS.run);
    expect(listed[0]).toMatchObject({ downloads: 2 });
  });

  it("is refused for a clip not on the page, past the link's allowance, or through a dead link", async () => {
    const h = guestHarness();
    const shared = seedClip(h.db, 1);
    const other = seedClip(h.db, 2);
    const { id, token } = await share(h, { allClips: false, clipIds: [shared] });

    const notShared = await refusal(h.pages.countDownload(token, { clipId: other, file: "video" }));
    expect(notShared.code).toBe(GUEST_ERRORS.clipNotFound);
    expect(notShared.httpStatus).toBe(404);

    h.linkBucket = 0;
    const tooMany = await refusal(h.pages.countDownload(token, { clipId: shared, file: "clean" }));
    expect(tooMany.httpStatus).toBe(429);

    h.linkBucket = 10;
    await h.links.revokeLink(IDS.ws, EDITOR, IDS.run, id);
    const dead = await refusal(h.pages.countDownload(token, { clipId: shared, file: "video" }));
    expect(dead.code).toBe(GUEST_ERRORS.linkRevoked);
    expect(h.db.tables.clipGuestLink[0]).toMatchObject({ downloadCount: 0 });
  });
});
