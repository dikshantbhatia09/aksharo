/**
 * Guest pages (2026-10-05) against a real PostgreSQL: the migration, and a guest
 * link's whole life through the queries the unit tests can only imitate - the
 * token-hash lookup, the `text[]` of shared clips, the live-link count, the
 * clean cuts' media statuses, a dub's shapes and exports, the episode text in
 * `llm_outputs`, the download count's increment and its audit row, the
 * approval rule read from `workspaces.settings`, and the cascade with the run.
 *
 * Nothing here touches object storage or Redis: signing is a fake that never
 * writes, and so are the rate limiter, the entitlement read and the
 * notification queue.
 */
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CommonAuditService } from "../src/common/audit/audit.service.js";
import { GuestLinksService } from "../src/repurpose/guest/guest-links.service.js";
import { GuestPageService } from "../src/repurpose/guest/guest-page.service.js";
import { createGuestLinkSchema } from "../src/repurpose/guest/guest.dto.js";
import { ClipApprovalGate } from "../src/repurpose/review/clip-approval.gate.js";
import { ClipReviewService } from "../src/repurpose/review/clip-review.service.js";
import { ReviewNotifier } from "../src/repurpose/review/review-notifier.js";
import { hashReviewToken } from "../src/repurpose/review/review-token.js";

import type { TestDatabase } from "./db-harness.js";
import type { RateLimitService } from "../src/common/guards/index.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { EntitlementService } from "../src/workspaces/entitlement.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();

if (!available) {
  console.warn(
    "[guest-links.e2e] SKIPPED - no test database. Set TEST_DATABASE_URL, or start Docker. " +
      `Reason: ${skipReason}`,
  );
}

const BASE = "01JGST0000000000000000000000";
const id = (suffix: string): string => (BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();

const OWNER = id("U1");
const EDITOR = id("U2");
const WS = id("W1");
const SOURCE = id("P1");
const RUN = id("R1");

describe.skipIf(!available)("guest links against PostgreSQL", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let reviews: ClipReviewService;
  let links: GuestLinksService;
  let pages: GuestPageService;
  const signed: string[] = [];

  /** A clip in the run, with a 9:16 variant, one finished render and its clean cut. */
  async function seedClip(
    n: number,
    options: { readonly removed?: boolean } = {},
  ): Promise<{ clipId: string; projectId: string; exportId: string }> {
    const candidateId = id(`C${String(n)}`);
    const clipId = id(`K${String(n)}`);
    const projectId = id(`V${String(n)}`);
    const exportId = id(`E${String(n)}`);
    await prisma.clipCandidate.create({
      data: {
        id: candidateId,
        runId: RUN,
        source: "ai",
        rank: n,
        potentialScore: 70,
        startMs: n * 60_000,
        endMs: n * 60_000 + 30_000,
        title: `Moment ${String(n)}`,
        state: options.removed === true ? "rejected" : "materialized",
      },
    });
    await prisma.repurposeClip.create({
      data: {
        id: clipId,
        runId: RUN,
        candidateId,
        title: `Clip ${String(n)}`,
        sourceStartMs: n * 60_000,
        sourceEndMs: n * 60_000 + 30_000,
        mezzanineDurationMs: 30_000,
        copy: {
          summary: "Why most people never save",
          hook: "Stop doing this",
          cta: "",
          hashtags: ["#money"],
          locale: "en",
          title: `Clip ${String(n)}`,
          description: "The one habit.",
          platforms: { instagram: { caption: "The one habit. #money" } },
        },
        images: {
          fingerprint: `9:16:${exportId}`,
          images: [
            {
              name: "vertical-image-1",
              key: `ws/${WS}/p/${SOURCE}/clips/${clipId}/images/vertical-image-1.jpg`,
              width: 1080,
              height: 1920,
            },
          ],
        },
      },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId: WS, title: `Clip ${String(n)} (9:16)` },
    });
    await prisma.mediaAsset.create({
      data: {
        id: id(`M${String(n)}`),
        projectId,
        role: "primary",
        storageKey: `ws/${WS}/p/${projectId}/media/${id(`M${String(n)}`)}/master.mp4`,
        status: "ready",
      },
    });
    await prisma.export.create({
      data: {
        id: exportId,
        workspaceId: WS,
        projectId,
        status: "succeeded",
        kind: "mp4",
        storageKey: `ws/${WS}/p/${projectId}/exports/${exportId}.mp4`,
        durationMs: 29_000,
      },
    });
    await prisma.clipVariant.create({
      data: {
        id: id(`A${String(n)}`),
        clipId,
        projectId,
        aspect: "r9x16",
        status: "ready",
        latestExportId: exportId,
      },
    });
    return { clipId, projectId, exportId };
  }

  /** A Hindi dub of the clip, its 9:16 shape made and captioned. */
  async function seedDub(clipId: string): Promise<void> {
    const dubId = id("D1");
    const projectId = id("DP1");
    await prisma.clipDub.create({
      data: {
        id: dubId,
        runId: RUN,
        clipId,
        workspaceId: WS,
        sourceLanguage: "en-IN",
        languages: ["hi-IN"],
        status: "ready",
        durationMs: 30_000,
        costTenths: 125,
        consentBy: OWNER,
        consentAt: new Date(),
      },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId: WS, title: "Clip 1 (9:16, Hindi)" },
    });
    await prisma.mediaAsset.create({
      data: {
        id: id("DM1"),
        projectId,
        role: "primary",
        storageKey: `ws/${WS}/p/${projectId}/media/${id("DM1")}/dubbed.mp4`,
        status: "ready",
      },
    });
    await prisma.export.create({
      data: {
        id: id("DE1"),
        workspaceId: WS,
        projectId,
        status: "succeeded",
        kind: "mp4",
        storageKey: `ws/${WS}/p/${projectId}/exports/${id("DE1")}.mp4`,
        durationMs: 30_000,
      },
    });
    await prisma.clipDubVariant.create({
      data: {
        id: id("DV1"),
        dubId,
        language: "hi-IN",
        aspect: "r9x16",
        projectId,
        status: "ready",
        latestExportId: id("DE1"),
      },
    });
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;

    await prisma.user.create({ data: { id: OWNER, email: "gl-owner@example.test", name: "Olga" } });
    await prisma.user.create({
      data: { id: EDITOR, email: "gl-editor@example.test", name: "Ravi" },
    });
    await prisma.workspace.create({
      data: { id: WS, slug: "gl", name: "Guest", ownerId: OWNER, billingCountry: "IN" },
    });
    for (const [userId, role] of [
      [OWNER, "owner"],
      [EDITOR, "editor"],
    ] as const) {
      await prisma.membership.create({
        data: { id: ulid(), workspaceId: WS, userId, role, status: "active" },
      });
    }
    await prisma.project.create({ data: { id: SOURCE, workspaceId: WS, title: "Podcast 12" } });
    await prisma.repurposeRun.create({
      data: {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SOURCE,
        sourceKind: "upload",
        mode: "ai",
        createdBy: EDITOR,
        sourceTitle: "Podcast 12",
      },
    });

    const service = prisma as unknown as PrismaService;
    const env = {
      FEATURE_FLAGS_JSON: { repurpose_flow: true, "shares.public": true },
      WEB_ORIGIN: "https://aksharo.test",
    } as unknown as Env;
    const notify = {
      enqueue: async (input: { idempotencyKey?: string }) => ({
        idempotencyKey: input.idempotencyKey ?? "",
        enqueued: true,
      }),
    } as unknown as NotifyService;
    const derived = {
      presignGet: async (key: string, ttl: number) => {
        signed.push(key);
        return `https://media.test/${key}?X-Amz-Expires=${String(ttl)}`;
      },
    } as unknown as ObjectStore;
    const audit = new CommonAuditService(service);
    const gate = new ClipApprovalGate(service);
    reviews = new ClipReviewService(
      service,
      audit,
      new ReviewNotifier(service, notify, env),
      gate,
      {
        forWorkspace: async () => ({ entitlements: { flags: {} } }),
      } as unknown as EntitlementService,
      env,
      derived,
    );
    links = new GuestLinksService(service, audit, reviews, env);
    pages = new GuestPageService(
      service,
      reviews,
      gate,
      audit,
      {
        consume: async () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }),
      } as unknown as RateLimitService,
      derived,
    );
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("creates one table that keeps a hash, never a token", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clip_guest_links'`;
    const types = new Map(columns.map((row) => [row.column_name, row.data_type]));
    expect(types.get("token_hash")).toBe("text");
    expect(types.get("clip_ids")).toBe("ARRAY");
    expect(types.has("token")).toBe(false);
  });

  it("lives its whole life: made, opened, downloaded from, listed and revoked", async () => {
    const one = await seedClip(1);
    const two = await seedClip(2);
    await seedClip(3, { removed: true });
    await seedDub(one.clipId);
    await prisma.llmOutput.create({
      data: {
        id: ulid(),
        projectId: SOURCE,
        workspaceId: WS,
        kind: "episode-pack",
        templateVersion: "1",
        provider: "mock",
        region: "in",
        output: {
          chapters: [],
          youtubeDescription: "",
          showNotes: "",
          linkedinPost: "What we talked about",
          xThread: ["1/ We talked"],
          newsletter: "",
        },
      },
    });

    const created = await links.createLink(
      WS,
      { userId: EDITOR, role: "editor" },
      RUN,
      createGuestLinkSchema.parse({
        clipIds: [one.clipId],
        guestName: "Priya",
        includeDubs: true,
      }),
    );
    const token = created.url.split("/").at(-1) ?? "";
    expect(
      await prisma.clipGuestLink.findUnique({ where: { tokenHash: hashReviewToken(token) } }),
    ).toMatchObject({ id: created.id, clipIds: [one.clipId], guestName: "Priya" });

    const page = await pages.open(token);
    expect(page).toMatchObject({
      title: "Podcast 12",
      guestName: "Priya",
      comingSoon: 0,
      episode: { linkedin: "What we talked about", xThread: ["1/ We talked"] },
    });
    expect(page.clips.map((clip) => clip.id)).toEqual([one.clipId]);
    const [clip] = page.clips;
    expect(clip?.videos).toEqual([
      expect.objectContaining({
        shape: "9:16",
        url: expect.stringContaining(`${one.exportId}.mp4`),
        cleanUrl: expect.stringContaining("master.mp4"),
      }),
    ]);
    expect(clip?.player?.posterUrl).toContain("vertical-image-1.jpg");
    expect(clip?.dubs.map((dub) => dub.name)).toEqual(["Hindi"]);
    expect(clip?.posts.map((post) => post.platform)).toEqual(["any", "instagram"]);
    expect(signed.some((key) => key.includes(two.projectId))).toBe(false);

    await pages.countDownload(
      token,
      { clipId: one.clipId, file: "video", shape: "9:16" },
      { ip: "203.0.113.7" },
    );
    const [listed] = await links.listLinks(WS, RUN);
    expect(listed).toMatchObject({ visits: 1, downloads: 1, clipCount: 1, status: "live" });

    await links.revokeLink(WS, { userId: EDITOR, role: "editor" }, RUN, created.id);
    await expect(pages.open(token)).rejects.toMatchObject({ code: "guest/link_revoked" });

    const audit = await prisma.auditLog.findMany({
      where: { resourceId: created.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((row) => [row.action, row.actorKind])).toEqual([
      ["repurpose.guest_link.created", "user"],
      ["repurpose.guest_link.downloaded", "guest"],
      ["repurpose.guest_link.revoked", "user"],
    ]);
    expect(audit[1]?.ip).toBe("203.0.113.7");
  });

  it("counts only live links toward a run's twenty", async () => {
    await prisma.clipGuestLink.create({
      data: {
        id: ulid(),
        workspaceId: WS,
        runId: RUN,
        tokenHash: "expired-link",
        tokenHint: "past",
        allClips: true,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const live = await prisma.clipGuestLink.count({
      where: { workspaceId: WS, runId: RUN, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(live).toBe(0);
  });

  it("holds a clip back until it is approved, when the workspace needs approval", async () => {
    const created = await links.createLink(
      WS,
      { userId: EDITOR, role: "editor" },
      RUN,
      createGuestLinkSchema.parse({ allClips: true }),
    );
    const token = created.url.split("/").at(-1) ?? "";
    await prisma.workspace.update({
      where: { id: WS },
      data: { settings: { clipsNeedApproval: true } },
    });
    const waiting = await pages.open(token);
    expect(waiting.clips).toEqual([]);
    expect(waiting.comingSoon).toBe(2);

    await reviews.decideAsMember(WS, { userId: OWNER, role: "owner" }, RUN, id("K2"), {
      decision: "approved",
    });
    const approved = await pages.open(token);
    expect(approved.clips.map((clip) => clip.id)).toEqual([id("K2")]);
    expect(approved.comingSoon).toBe(1);
  });

  it("goes with its run", async () => {
    expect(await prisma.clipGuestLink.count()).toBeGreaterThan(0);
    await prisma.repurposeRun.delete({ where: { id: RUN } });
    expect(await prisma.clipGuestLink.count()).toBe(0);
  });
});
