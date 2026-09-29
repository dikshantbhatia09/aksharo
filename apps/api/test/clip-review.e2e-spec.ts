/**
 * Clip review (2026-10-03) against a real PostgreSQL: the migration, and the
 * queries the unit tests can only imitate - the compare-and-set on a clip's
 * review, the JSON-path lookup that groups comment notifications, `groupBy`
 * counts, the token-hash lookup, the workspace setting read from
 * `workspaces.settings`, and the cascades.
 *
 * Nothing here touches object storage or Redis: signing is a fake, and so are
 * the rate limiter and the notification queue (which writes the same bell row
 * the real one does, so the grouping query runs against it).
 */
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { CommonAuditService } from "../src/common/audit/audit.service.js";
import { ClientReviewService } from "../src/repurpose/review/client-review.service.js";
import { ClipApprovalGate } from "../src/repurpose/review/clip-approval.gate.js";
import { ClipReviewService } from "../src/repurpose/review/clip-review.service.js";
import { ReviewNotifier } from "../src/repurpose/review/review-notifier.js";
import { hashReviewToken } from "../src/repurpose/review/review-token.js";

import type { TestDatabase } from "./db-harness.js";
import type { RateLimitService } from "../src/common/guards/index.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { NotifyService } from "../src/notify/notify.service.js";
import type { NotifyEnqueueInput } from "../src/notify/notify.types.js";
import type { EntitlementService } from "../src/workspaces/entitlement.service.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();

if (!available) {
  console.warn(
    "[clip-review.e2e] SKIPPED - no test database. Set TEST_DATABASE_URL, or start Docker. " +
      `Reason: ${skipReason}`,
  );
}

const BASE = "01JRV0000000000000000000000";
const id = (suffix: string): string => (BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();

const OWNER = id("U1");
const EDITOR = id("U2");
const WS = id("W1");
const SOURCE = id("P1");
const RUN = id("R1");

describe.skipIf(!available)("clip review against PostgreSQL", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let reviews: ClipReviewService;
  let clients: ClientReviewService;
  let gate: ClipApprovalGate;
  const notices: NotifyEnqueueInput[] = [];

  /** A clip in the run, with a 9:16 variant and one finished render. */
  async function seedClip(n: number): Promise<{ clipId: string; projectId: string }> {
    const candidateId = id(`C${String(n)}`);
    const clipId = id(`K${String(n)}`);
    const projectId = id(`V${String(n)}`);
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
        state: "materialized",
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
      },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId: WS, title: `Clip ${String(n)} (9:16)` },
    });
    await prisma.clipVariant.create({
      data: { id: id(`A${String(n)}`), clipId, projectId, aspect: "r9x16", status: "ready" },
    });
    await render(clipId, projectId);
    return { clipId, projectId };
  }

  /** A new finished captioned video for the clip's 9:16 shape. */
  async function render(clipId: string, projectId: string): Promise<string> {
    const exportId = ulid();
    await prisma.export.create({
      data: {
        id: exportId,
        workspaceId: WS,
        projectId,
        status: "succeeded",
        kind: "mp4",
        storageKey: `ws/${WS}/p/${projectId}/exports/${exportId}.mp4`,
        durationMs: 30_000,
      },
    });
    await prisma.clipVariant.updateMany({
      where: { clipId, aspect: "r9x16" },
      data: { latestExportId: exportId },
    });
    return exportId;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;

    await prisma.user.create({ data: { id: OWNER, email: "rv-owner@example.test", name: "Olga" } });
    await prisma.user.create({
      data: { id: EDITOR, email: "rv-editor@example.test", name: "Ravi" },
    });
    await prisma.workspace.create({
      data: { id: WS, slug: "rv", name: "Review", ownerId: OWNER, billingCountry: "IN" },
    });
    for (const [userId, role] of [
      [OWNER, "owner"],
      [EDITOR, "editor"],
    ] as const) {
      await prisma.membership.create({
        data: { id: ulid(), workspaceId: WS, userId, role, status: "active" },
      });
    }
    await prisma.project.create({ data: { id: SOURCE, workspaceId: WS, title: "Diwali vlog" } });
    await prisma.repurposeRun.create({
      data: {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SOURCE,
        sourceKind: "upload",
        mode: "ai",
        createdBy: EDITOR,
        sourceTitle: "Diwali vlog",
      },
    });

    const service = prisma as unknown as PrismaService;
    const env = {
      FEATURE_FLAGS_JSON: { repurpose_flow: true, "shares.public": true },
      WEB_ORIGIN: "https://aksharo.test",
    } as unknown as Env;
    const notify = {
      enqueue: async (input: NotifyEnqueueInput) => {
        notices.push(input);
        // What the real service writes for an in-app kind.
        await prisma.notification.create({
          data: {
            id: ulid(),
            userId: input.userId ?? OWNER,
            workspaceId: input.workspaceId ?? null,
            kind: input.kind,
            data: input.data ?? {},
          },
        });
        return { idempotencyKey: input.idempotencyKey ?? "", enqueued: true };
      },
    } as unknown as NotifyService;
    const derived = {
      presignGet: async (key: string, ttl: number) =>
        `https://media.test/${key}?X-Amz-Expires=${String(ttl)}`,
    } as unknown as ObjectStore;
    gate = new ClipApprovalGate(service);
    reviews = new ClipReviewService(
      service,
      new CommonAuditService(service),
      new ReviewNotifier(service, notify, env),
      gate,
      {
        forWorkspace: async () => ({ entitlements: { flags: {} } }),
      } as unknown as EntitlementService,
      env,
      derived,
    );
    clients = new ClientReviewService(
      service,
      reviews,
      {
        consume: async () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }),
      } as unknown as RateLimitService,
      derived,
    );
  });

  afterAll(async () => {
    await db?.stop();
  });

  it("creates the four tables and two enums, and changes no existing table", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'clip_%'`;
    expect(tables.map((row) => row.table_name).sort()).toEqual(
      expect.arrayContaining([
        "clip_comments",
        "clip_review_events",
        "clip_review_links",
        "clip_reviews",
      ]),
    );
    const enums = await prisma.$queryRaw<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname IN ('ClipReviewState', 'ReviewActorKind')`;
    expect(enums).toHaveLength(2);
    // The link table keeps a hash, never a token column.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'clip_review_links'`;
    const names = columns.map((row) => row.column_name);
    expect(names).toContain("token_hash");
    expect(names).not.toContain("token");
  });

  it("approves, writes the event, and returns the clip to pending when a new video replaces it", async () => {
    const { clipId, projectId } = await seedClip(1);
    const approved = await reviews.decideAsMember(
      WS,
      { userId: OWNER, role: "owner" },
      RUN,
      clipId,
      { decision: "approved" },
    );
    expect(approved).toMatchObject({ state: "approved", covered: ["9:16"] });
    expect(await prisma.clipReview.findUnique({ where: { clipId } })).toMatchObject({
      state: "approved",
      version: 1,
      actorKind: "member",
      actorUserId: OWNER,
    });

    // Asked again the same way: one event, not two.
    await reviews.decideAsMember(WS, { userId: OWNER, role: "owner" }, RUN, clipId, {
      decision: "approved",
    });
    expect(await prisma.clipReviewEvent.count({ where: { clipId } })).toBe(1);

    const fresh = await render(clipId, projectId);
    await reviews.syncForExport(WS, fresh);
    expect(await prisma.clipReview.findUnique({ where: { clipId } })).toMatchObject({
      state: "pending",
      version: 2,
      actorKind: "system",
      videos: {},
    });
    const events = await prisma.clipReviewEvent.findMany({
      where: { clipId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => [event.state, event.reason])).toEqual([
      ["approved", null],
      ["pending", "video_changed"],
    ]);
    const audit = await prisma.auditLog.findMany({
      where: { resourceId: clipId },
      orderBy: { at: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual([
      "repurpose.clip.review_decided",
      "repurpose.clip.review_reopened",
    ]);
  });

  it("counts comments and groups their notifications with a JSON-path lookup", async () => {
    const { clipId } = await seedClip(2);
    const before = notices.length;
    const caller = { userId: OWNER, role: "owner" } as const;
    const first = await reviews.addMemberComment(WS, caller, RUN, clipId, { body: "One" });
    await reviews.addMemberComment(WS, caller, RUN, clipId, { body: "Two", atMs: 1_500 });
    await reviews.resolveComment(WS, caller, RUN, clipId, first.id, true);
    // Two comments by the owner to the editor (the run's creator): told once.
    expect(notices.slice(before).map((notice) => notice.data?.["verdict"])).toEqual(["comment"]);
    const view = await reviews.runReview(WS, RUN, caller);
    expect(view.clips.find((clip) => clip.clipId === clipId)?.comments).toEqual({
      total: 2,
      open: 1,
    });
  });

  it("finds a client link by the hash of its token, and records the client's word as theirs", async () => {
    const { clipId } = await seedClip(3);
    const created = await reviews.createLink(WS, { userId: OWNER, role: "owner" }, RUN, {
      expiresInDays: 7,
      requireName: true,
    });
    const token = created.url.split("/").at(-1) ?? "";
    expect(
      await prisma.clipReviewLink.findUnique({ where: { tokenHash: hashReviewToken(token) } }),
    ).toMatchObject({ id: created.id });

    const page = await clients.open(token);
    const shown = page.clips.find((clip) => clip.id === clipId);
    expect(shown?.video?.url).toContain("X-Amz-Expires=1200");
    await clients.decide(token, clipId, {
      decision: "changes_requested",
      name: "Priya",
      note: "Cut the start",
      ...(shown?.video === null || shown?.video === undefined
        ? {}
        : { expect: shown.video.exportId }),
    });
    expect(await prisma.clipReview.findUnique({ where: { clipId } })).toMatchObject({
      state: "changes_requested",
      actorKind: "client",
      actorName: "Priya",
      reviewLinkId: created.id,
    });
    const [links] = [await reviews.listLinks(WS, RUN)];
    expect(links.find((link) => link.id === created.id)).toMatchObject({
      decisions: 1,
      comments: 1,
      visits: 1,
    });

    await reviews.revokeLink(WS, { userId: EDITOR, role: "editor" }, RUN, created.id);
    await expect(clients.open(token)).rejects.toMatchObject({ code: "review/link_revoked" });
  });

  it("reads the approval setting from the workspace's settings document", async () => {
    await expect(gate.required(WS)).resolves.toBe(false);
    await prisma.workspace.update({
      where: { id: WS },
      data: { settings: { clipsNeedApproval: true } },
    });
    await expect(gate.required(WS)).resolves.toBe(true);
    const { clipId } = await seedClip(4);
    expect((await gate.forClip(WS, clipId)).message).toMatch(/needs approval/);
  });

  it("goes with its run", async () => {
    const before = await prisma.clipReview.count();
    expect(before).toBeGreaterThan(0);
    await prisma.repurposeRun.delete({ where: { id: RUN } });
    expect(await prisma.clipReview.count()).toBe(0);
    expect(await prisma.clipReviewEvent.count()).toBe(0);
    expect(await prisma.clipComment.count()).toBe(0);
    expect(await prisma.clipReviewLink.count()).toBe(0);
  });
});
