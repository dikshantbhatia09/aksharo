import { describe, expect, it } from "vitest";

import {
  IDS,
  guestHarness,
  seedClip,
  tokenOf,
  type GuestHarness,
} from "./guest-memory.test-support.js";
import { GUEST_ERRORS, MAX_GUEST_LINKS_PER_RUN } from "./guest.constants.js";
import { createGuestLinkSchema, type CreateGuestLinkInput } from "./guest.dto.js";
import { AppException } from "../../common/errors/error-codes.js";
import { hashReviewToken } from "../review/review-token.js";

import type { MemberCaller } from "../review/clip-review.service.js";

const EDITOR: MemberCaller = { userId: IDS.editor, role: "editor" };

async function refusal(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/**
 * A request as the controller's validation hands it over: the schema's
 * defaults, then the test's own fields (the fake's clip ids are not ULIDs).
 */
function input(over: Partial<CreateGuestLinkInput> = {}): CreateGuestLinkInput {
  return { ...createGuestLinkSchema.parse({ allClips: true }), ...over };
}

async function make(h: GuestHarness, over: Partial<CreateGuestLinkInput> = {}) {
  return h.links.createLink(IDS.ws, EDITOR, IDS.run, input(over));
}

describe("making a guest link", () => {
  it("shares every clip for 14 days unless asked, and shows the link once", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    seedClip(h.db, 2);
    // As the request's validation leaves it: control characters out, spaces folded.
    const { guestName } = createGuestLinkSchema.parse({
      allClips: true,
      guestName: "  Priya \u0007 Rao ",
    });
    const created = await make(h, guestName === undefined ? {} : { guestName });
    const token = tokenOf(created.url);
    expect(created.url).toBe(`https://aksharo.test/share/guest/${token}`);
    expect(token).toMatch(/^[0-9A-Za-z]{24}$/);
    expect(created).toMatchObject({
      runId: IDS.run,
      guestName: "Priya Rao",
      allClips: true,
      clipIds: [],
      clipCount: 2,
      includeDubs: false,
      status: "live",
      expiresAt: "2026-10-19T06:00:00.000Z",
      visits: 0,
      downloads: 0,
      hint: token.slice(-4),
    });

    // Only the token's hash is kept, never the token.
    const row = h.db.tables.clipGuestLink[0];
    expect(row?.["tokenHash"]).toBe(hashReviewToken(token));
    expect(JSON.stringify(h.db.tables.clipGuestLink)).not.toContain(token);
  });

  it("is audited with who made it and what it shares, never the token or the guest's name", async () => {
    const h = guestHarness();
    const clip = seedClip(h.db, 1);
    const created = await make(h, {
      allClips: false,
      clipIds: [clip],
      includeDubs: true,
      expiresInDays: 3,
      guestName: "Priya",
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: "repurpose.guest_link.created",
      resource: "clip_guest_link",
      resourceId: created.id,
      actorId: IDS.editor,
      workspaceId: IDS.ws,
      data: {
        runId: IDS.run,
        allClips: false,
        clipIds: [clip],
        includeDubs: true,
        named: true,
        expiresAt: "2026-10-08T06:00:00.000Z",
      },
    });
    const audit = JSON.stringify(h.audits);
    expect(audit).not.toContain(tokenOf(created.url));
    expect(audit).not.toContain("Priya");
  });

  it("names only clips of this run that are on its page", async () => {
    const h = guestHarness();
    const mine = seedClip(h.db, 1);
    const removed = seedClip(h.db, 2, { removed: true });
    const elsewhere = seedClip(h.db, 3, { runId: IDS.otherRun });

    const created = await make(h, { allClips: false, clipIds: [mine, mine] });
    expect(created).toMatchObject({ allClips: false, clipIds: [mine], clipCount: 1 });

    for (const clipIds of [[elsewhere], [mine, removed], ["01JCLIP0000000000000000NONE"]]) {
      const refused = await refusal(make(h, { allClips: false, clipIds }));
      expect(refused.code).toBe(GUEST_ERRORS.clipNotInRun);
      expect(refused.httpStatus).toBe(400);
    }
    expect(h.db.tables.clipGuestLink).toHaveLength(1);
  });

  it("allows 20 live links a run; expired and revoked ones do not count", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const first = await make(h, { expiresInDays: 1 });
    for (let n = 1; n < MAX_GUEST_LINKS_PER_RUN; n += 1) await make(h);
    const refused = await refusal(make(h));
    expect(refused.code).toBe(GUEST_ERRORS.tooManyLinks);
    expect(refused.httpStatus).toBe(409);

    // A day on, the first has expired: room for one more.
    h.setNow(Date.parse("2026-10-06T06:00:01Z"));
    await make(h);
    await expect(make(h)).rejects.toMatchObject({ code: GUEST_ERRORS.tooManyLinks });
    const live = h.db.tables.clipGuestLink.find((row) => row["id"] !== first.id);
    await h.links.revokeLink(IDS.ws, EDITOR, IDS.run, String(live?.["id"]));
    await make(h);
  });

  it("answers 404 for another workspace's run, while clips are off, or while public links are off", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const otherWorkspace = await refusal(h.links.createLink(IDS.otherWs, EDITOR, IDS.run, input()));
    expect(otherWorkspace.httpStatus).toBe(404);

    const clipsOff = guestHarness({ flags: { repurpose_flow: false } });
    seedClip(clipsOff.db, 1);
    expect((await refusal(make(clipsOff))).httpStatus).toBe(404);

    const sharesOff = guestHarness({ publicShares: false });
    seedClip(sharesOff.db, 1);
    const off = await refusal(make(sharesOff));
    expect(off.httpStatus).toBe(404);
    expect(off.message).toMatch(/guest/);
  });
});

describe("the run's guest links", () => {
  it("lists them newest first, with visits, downloads and the clips each shares now", async () => {
    const h = guestHarness();
    const one = seedClip(h.db, 1);
    const two = seedClip(h.db, 2);
    const older = await make(h, { allClips: false, clipIds: [one, two] });
    h.setNow(Date.parse("2026-10-05T07:00:00Z"));
    const newer = await make(h);
    // Another run's link is not this run's.
    h.db.tables.clipGuestLink.push({
      ...h.db.tables.clipGuestLink[0],
      id: "01JGUEST00000000000000OTHR",
      runId: IDS.otherRun,
      tokenHash: "other",
    });
    const row = h.db.tables.clipGuestLink.find((entry) => entry["id"] === older.id);
    if (row !== undefined) {
      row["viewCount"] = 3;
      row["downloadCount"] = 7;
      row["lastDownloadedAt"] = new Date("2026-10-05T06:30:00Z");
    }
    // A clip removed from the run drops out of the link's count.
    const candidate = h.db.tables.clipCandidate.find((entry) => String(entry["id"]).endsWith("C2"));
    if (candidate !== undefined) candidate["state"] = "rejected";

    const links = await h.links.listLinks(IDS.ws, IDS.run);
    expect(links.map((link) => link.id)).toEqual([newer.id, older.id]);
    expect(links[1]).toMatchObject({
      visits: 3,
      downloads: 7,
      lastDownloadAt: "2026-10-05T06:30:00.000Z",
      clipIds: [one],
      clipCount: 1,
    });
    expect(links[0]).toMatchObject({ allClips: true, clipCount: 1 });
    expect(JSON.stringify(links)).not.toContain("tokenHash");
  });

  it("revokes one: audited once, and it says so from then on", async () => {
    const h = guestHarness();
    seedClip(h.db, 1);
    const created = await make(h);
    h.audits.length = 0;
    const revoked = await h.links.revokeLink(IDS.ws, EDITOR, IDS.run, created.id);
    expect(revoked).toMatchObject({ status: "revoked", revokedAt: "2026-10-05T06:00:00.000Z" });
    await h.links.revokeLink(IDS.ws, EDITOR, IDS.run, created.id);
    expect(h.audits.map((audit) => audit.action)).toEqual(["repurpose.guest_link.revoked"]);
    expect(h.audits[0]).toMatchObject({ actorId: IDS.editor, resourceId: created.id });

    const missing = await refusal(h.links.revokeLink(IDS.ws, EDITOR, IDS.otherRun, created.id));
    expect(missing.httpStatus).toBe(404);
    const unknown = await refusal(h.links.revokeLink(IDS.ws, EDITOR, IDS.run, "01JNOPE"));
    expect(unknown.code).toBe(GUEST_ERRORS.linkNotFound);
  });
});

describe("the request to make one", () => {
  it("shares every clip or names them, never both and never neither", () => {
    expect(createGuestLinkSchema.safeParse({}).success).toBe(false);
    expect(
      createGuestLinkSchema.safeParse({ allClips: true, clipIds: ["01JRV0000000000000000000K1"] })
        .success,
    ).toBe(false);
    expect(createGuestLinkSchema.safeParse({ clipIds: ["not-a-clip"] }).success).toBe(false);
    expect(createGuestLinkSchema.parse({ clipIds: ["01JRV0000000000000000000K1"] })).toMatchObject({
      allClips: false,
      expiresInDays: 14,
      includeDubs: false,
    });
    for (const expiresInDays of [0, 31, 1.5]) {
      expect(createGuestLinkSchema.safeParse({ allClips: true, expiresInDays }).success).toBe(
        false,
      );
    }
    expect(
      createGuestLinkSchema.safeParse({ allClips: true, guestName: "x".repeat(61) }).success,
    ).toBe(false);
  });
});
