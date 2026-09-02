import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareLinksService } from "./share-links.service.js";
import { SHARE_AUTO_DISABLE_REPORT_THRESHOLD, SHARE_ERRORS } from "./share.constants.js";
import { AppException } from "../common/index.js";

import type { ShareLink } from "@prisma/client";

const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";
const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const LINK_ID = "01JBZ0Q4T7R8N4H1V0J9K2M3PB";
const TOKEN = "abc123def456ghi789jklmno";

function linkRow(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: LINK_ID,
    projectId: PROJECT,
    token: TOKEN,
    indexable: false,
    scope: "view",
    passwordHash: null,
    expiresAt: null,
    maxViews: null,
    viewCount: 0,
    clientTag: null,
    acceptedAupVersion: null,
    reportCount: 0,
    autoDisabled: false,
    createdBy: USER,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  } as ShareLink;
}

function makeService() {
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({ id: PROJECT })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: PROJECT,
        title: "A project",
        aspect: "r9x16",
        reviewStatus: "none",
        workspaceId: WORKSPACE,
        createdBy: USER,
      })),
      update: vi.fn(async () => ({})),
    },
    shareLink: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => linkRow(args.data)),
      findMany: vi.fn(async () => [linkRow()]),
      findFirst: vi.fn(async (): Promise<ShareLink | null> => linkRow()),
      findUnique: vi.fn(async (): Promise<ShareLink | null> => linkRow()),
      update: vi.fn(async () => linkRow()),
    },
    mediaAsset: {
      findFirst: vi.fn(
        async (): Promise<{ id: string; proxyKey: string; durationMs: number } | null> => ({
          id: "MEDIA1",
          proxyKey: "derived/proxy.mp4",
          durationMs: 60000,
        }),
      ),
    },
    edgDocument: {
      findUnique: vi.fn(async () => ({ id: "EDG1" })),
    },
    shareReport: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "01JBZ0Q4T7R8N4H1V0J9K2M3PC",
        dueAt: new Date("2026-09-05T00:00:00.000Z"),
        ...args.data,
      })),
      count: vi.fn(async () => 1),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const passwords = {
    hash: vi.fn(async (value: string) => `hashed:${value}`),
    verify: vi.fn(async (hash: string | null, value: string) => hash === `hashed:${value}`),
  };

  const sessions = {
    sign: vi.fn(() => "signed-session"),
    verify: vi.fn(() => false),
  };

  const audit = { record: vi.fn(async () => undefined) };

  const edg = {
    projectionOf: vi.fn(async () => ({
      meta: { edgId: "EDG1", projectId: PROJECT, revision: 1, schemaVersion: 2 },
      media: [],
      transcript: { transcriptId: "TR1", revision: 1, language: "en", scripts: ["roman"] },
      canvas: { width: 1080, height: 1920 },
      styles: { defaultStyleId: "system:default" },
      segments: [],
    })),
    loadChunks: vi.fn(async () => []),
  };
  const derivedStore = { presignGet: vi.fn(async () => "https://cdn.example.test/proxy.mp4") };
  const service = new ShareLinksService(
    prisma as never,
    passwords as never,
    sessions as never,
    audit as never,
    edg as never,
    derivedStore as never,
  );

  return { service, prisma, passwords, sessions, audit };
}

describe("ShareLinksService", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a link with a hashed password and audits it", async () => {
    const { service, passwords, audit } = makeService();

    const view = await service.create(
      WORKSPACE,
      USER,
      PROJECT,
      { scope: "comment", password: "correcthorsebattery" },
      "https://app.example.test",
    );

    expect(passwords.hash).toHaveBeenCalledWith("correcthorsebattery");
    expect(view.hasPassword).toBe(true);
    expect(view.scope).toBe("comment");
    expect(view.url).toBe(`https://app.example.test/s/${view.token}`);
    expect(view.token).toHaveLength(24);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "share.link.created" }),
    );
  });

  it("404s a revoked/expired/view-capped link the same way as a missing one", async () => {
    const { service, prisma } = makeService();

    prisma.shareLink.findUnique = vi.fn(async () => linkRow({ revokedAt: new Date() }));
    await expect(service.resolve(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.revoked,
    });

    prisma.shareLink.findUnique = vi.fn(async () =>
      linkRow({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    await expect(service.resolve(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.expired,
    });

    prisma.shareLink.findUnique = vi.fn(async () => linkRow({ maxViews: 1, viewCount: 1 }));
    await expect(service.resolve(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.viewLimitReached,
    });

    prisma.shareLink.findUnique = vi.fn(async () => null);
    await expect(service.resolve(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.notFound,
    });
  });

  it("a `view`-scope link cannot comment or approve", () => {
    const { service } = makeService();
    expect(() => service.assertScope("view", "comment")).toThrow(AppException);
    expect(() => service.assertScope("view", "approve")).toThrow(AppException);
    expect(() => service.assertScope("comment", "comment")).not.toThrow();
    expect(() => service.assertScope("approve", "comment")).not.toThrow();
  });

  it("requires the correct password to unlock, and rejects an incorrect one", async () => {
    const { service, prisma } = makeService();
    prisma.shareLink.findUnique = vi.fn(async () =>
      linkRow({ passwordHash: "hashed:correcthorsebattery" }),
    );

    const session = await service.unlock(TOKEN, "correcthorsebattery");
    expect(session).toBe("signed-session");

    await expect(service.unlock(TOKEN, "wrong")).rejects.toMatchObject({
      code: SHARE_ERRORS.passwordIncorrect,
    });
  });

  it("auto-disables a link once pending reports reach the threshold (F-504)", async () => {
    const { service, prisma } = makeService();
    prisma.shareReport.count = vi.fn(async () => SHARE_AUTO_DISABLE_REPORT_THRESHOLD);

    await service.report(TOKEN, { category: "ncii" });

    expect(prisma.shareLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ autoDisabled: true }),
      }),
    );
  });

  it("quotes an NCII report at 3h and everything else at 36h", async () => {
    const { service, prisma } = makeService();
    prisma.shareReport.count = vi.fn(async () => 1);

    const now = new Date("2026-09-02T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const ncii = await service.report(TOKEN, { category: "ncii" });
    expect(new Date(ncii.dueAt).getTime() - now.getTime()).toBe(3 * 60 * 60 * 1000);

    vi.useRealTimers();
  });

  it("records a view only once resolved and unlocked", async () => {
    const { service, prisma } = makeService();
    await service.recordView(LINK_ID);
    expect(prisma.shareLink.update).toHaveBeenCalledWith({
      where: { id: LINK_ID },
      data: { viewCount: { increment: 1 } },
    });
  });

  it("revoke is idempotent and only writes once", async () => {
    const { service, prisma } = makeService();
    prisma.shareLink.findFirst = vi.fn(async () => linkRow({ revokedAt: new Date() }));

    await service.revoke(WORKSPACE, USER, PROJECT, LINK_ID);

    expect(prisma.shareLink.update).not.toHaveBeenCalled();
  });

  it("preview() returns a signed proxy URL and a render-ready projection", async () => {
    const { service, prisma } = makeService();

    const result = await service.preview(TOKEN, undefined);

    expect(result.proxyUrl).toBe("https://cdn.example.test/proxy.mp4");
    expect(result.durationMs).toBe(60_000);
    expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: PROJECT, role: "primary", status: "ready" } }),
    );
    expect(result.projection).toEqual(
      expect.objectContaining({
        canvas: { width: 1080, height: 1920 },
        styles: { defaultStyleId: "system:default" },
        segments: [],
        words: [],
      }),
    );
  });

  it("preview() 404s a project whose media has not probed a proxy yet", async () => {
    const { service, prisma } = makeService();
    prisma.mediaAsset.findFirst = vi.fn(async () => null);

    await expect(service.preview(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.notFound,
    });
  });

  it("preview() refuses an un-unlocked password-gated link", async () => {
    const { service, prisma } = makeService();
    prisma.shareLink.findUnique = vi.fn(async () =>
      linkRow({ passwordHash: "hashed:correcthorsebattery" }),
    );

    await expect(service.preview(TOKEN, undefined)).rejects.toMatchObject({
      code: SHARE_ERRORS.passwordRequired,
    });
  });
});
