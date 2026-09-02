import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommentsService } from "./comments.service.js";
import { AppException } from "../common/index.js";
import { COMMENT_ERRORS } from "../share/share.constants.js";

import type { Comment } from "@prisma/client";

const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const OWNER = "01JBZ0Q4T7R8N4H1V0J9K2M3P9";
const COMMENT_ID = "01JBZ0Q4T7R8N4H1V0J9K2M3PD";

function commentRow(overrides: Partial<Comment> = {}): Comment {
  return {
    id: COMMENT_ID,
    projectId: PROJECT,
    shareLinkId: null,
    authorId: USER,
    authorName: null,
    authorEmailHash: null,
    body: "Looks great",
    atMs: 1200,
    segmentId: null,
    parentId: null,
    resolvedAt: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  } as Comment;
}

function makeService() {
  const prisma = {
    comment: {
      findFirst: vi.fn(async (): Promise<Comment | null> => commentRow()),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => commentRow(args.data)),
      findMany: vi.fn(async () => [commentRow()]),
      update: vi.fn(async () => commentRow({ resolvedAt: new Date() })),
    },
    project: {
      findUnique: vi.fn(async () => ({ id: PROJECT, title: "A project", createdBy: OWNER })),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: OWNER, email: "owner@example.test", locale: "en-IN" })),
    },
  };

  const notify = { enqueue: vi.fn(async () => ({ notificationId: null, jobId: "job1" })) };

  const service = new CommentsService(prisma as never, notify as never);
  return { service, prisma, notify };
}

describe("CommentsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a member comment and notifies the owner (share-comment)", async () => {
    const { service, notify } = makeService();

    const view = await service.add({ projectId: PROJECT, authorId: USER, body: "Nice cut" });

    expect(view.authorId).toBe(USER);
    expect(notify.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "share-comment", to: "owner@example.test" }),
    );
  });

  it("does not notify the owner when the owner is the commenter", async () => {
    const { service, prisma, notify } = makeService();
    prisma.project.findUnique = vi.fn(async () => ({
      id: PROJECT,
      title: "A project",
      createdBy: OWNER,
    }));

    await service.add({ projectId: PROJECT, authorId: OWNER, body: "self comment" });

    expect(notify.enqueue).not.toHaveBeenCalled();
  });

  it("requires a guest name when there is no authenticated author", async () => {
    const { service } = makeService();
    await expect(service.add({ projectId: PROJECT, body: "anon comment" })).rejects.toMatchObject({
      code: COMMENT_ERRORS.guestNameRequired,
    });
  });

  it("hashes a guest's email rather than storing it", async () => {
    const { service, prisma } = makeService();

    await service.add({
      projectId: PROJECT,
      body: "guest comment",
      author: { name: "Ravi", email: "ravi@example.test" },
    });

    const createArgs = (prisma.comment.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data["authorEmailHash"]).not.toBe("ravi@example.test");
    expect(typeof createArgs.data["authorEmailHash"]).toBe("string");
    expect((createArgs.data["authorEmailHash"] as string).length).toBe(64);
  });

  it("404s a reply whose parent does not exist", async () => {
    const { service, prisma } = makeService();
    prisma.comment.findFirst = vi.fn(async () => null);

    await expect(
      service.add({ projectId: PROJECT, authorId: USER, body: "reply", parentId: COMMENT_ID }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("resolves and reopens a comment", async () => {
    const { service, prisma } = makeService();

    await service.resolve(PROJECT, COMMENT_ID, true);
    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { resolvedAt: expect.any(Date) as Date },
    });
  });
});
