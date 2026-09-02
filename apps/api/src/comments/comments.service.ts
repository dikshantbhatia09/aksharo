import { createHash } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { AppException, PrismaService } from "../common/index.js";
import { NotifyService } from "../notify/notify.service.js";
import { COMMENT_ERRORS } from "../share/share.constants.js";

import type { CreateCommentDto } from "../share/share.dto.js";
import type { Comment } from "@prisma/client";

export interface CommentView {
  readonly id: string;
  readonly projectId: string;
  readonly shareLinkId: string | null;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly atMs: number | null;
  readonly segmentId: string | null;
  readonly parentId: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

function toView(comment: Comment): CommentView {
  return {
    id: comment.id,
    projectId: comment.projectId,
    shareLinkId: comment.shareLinkId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    body: comment.body,
    atMs: comment.atMs,
    segmentId: comment.segmentId,
    parentId: comment.parentId,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
  };
}

/** sha256, lowercased+trimmed first — never the address itself (DPDP). */
function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export interface AddCommentInput extends CreateCommentDto {
  readonly projectId: string;
  readonly shareLinkId?: string;
  readonly authorId?: string;
}

/**
 * Time-anchored comment threads on a project (B15 brief §2), reachable both from
 * the authenticated editor (`authorId` set, `shareLinkId` null) and from a public
 * share link with scope `comment`/`approve` (`shareLinkId` set, guest identity
 * from `author.name`/`author.email`).
 *
 * A digest notification (`share-comment`, already templated by A25/B15) is sent
 * to the project owner on every top-level thread; replies do not re-notify the
 * whole thread, only its root author when that author is a workspace member —
 * exactly what a reply-only-once inbox needs, without a separate thread model.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  async add(input: AddCommentInput): Promise<CommentView> {
    if (input.parentId !== undefined) {
      const parent = await this.prisma.comment.findFirst({
        where: { id: input.parentId, projectId: input.projectId, deletedAt: null },
      });
      if (parent === null) {
        throw new AppException(
          COMMENT_ERRORS.parentNotFound,
          "The comment being replied to was not found.",
          HttpStatus.NOT_FOUND,
        );
      }
    }

    if (
      input.authorId === undefined &&
      (input.author?.name === undefined || input.author.name === "")
    ) {
      throw new AppException(
        COMMENT_ERRORS.guestNameRequired,
        "A guest reviewer must give a name.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const comment = await this.prisma.comment.create({
      data: {
        id: ulid(),
        projectId: input.projectId,
        shareLinkId: input.shareLinkId ?? null,
        authorId: input.authorId ?? null,
        authorName: input.authorId === undefined ? (input.author?.name ?? null) : null,
        authorEmailHash:
          input.authorId === undefined && input.author?.email !== undefined
            ? hashEmail(input.author.email)
            : null,
        body: input.body,
        atMs: input.atMs ?? null,
        segmentId: input.segmentId ?? null,
        parentId: input.parentId ?? null,
      },
    });

    await this.notifyOwner(input.projectId, comment);

    return toView(comment);
  }

  private async notifyOwner(projectId: string, comment: Comment): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, title: true, createdBy: true },
    });
    if (project === null || project.createdBy === null) return;

    const owner = await this.prisma.user.findUnique({
      where: { id: project.createdBy },
      select: { id: true, email: true, locale: true },
    });
    if (owner === null || owner.id === comment.authorId) return;

    await this.notify.enqueue({
      kind: "share-comment",
      to: owner.email,
      userId: owner.id,
      locale: owner.locale ?? "en",
      data: {
        name: owner.email.split("@")[0] ?? "there",
        project: project.title,
        author: comment.authorName ?? "A reviewer",
        count: 1,
        link: `/p/${project.id}/review`,
      },
      idempotencyKey: `share-comment:${comment.id}`,
    });
  }

  async list(
    projectId: string,
    filter: { resolved?: boolean; segmentId?: string },
  ): Promise<CommentView[]> {
    const comments = await this.prisma.comment.findMany({
      where: {
        projectId,
        deletedAt: null,
        ...(filter.resolved === undefined
          ? {}
          : filter.resolved
            ? { resolvedAt: { not: null } }
            : { resolvedAt: null }),
        ...(filter.segmentId === undefined ? {} : { segmentId: filter.segmentId }),
      },
      orderBy: { createdAt: "asc" },
    });
    return comments.map(toView);
  }

  async resolve(projectId: string, commentId: string, resolved: boolean): Promise<CommentView> {
    const comment = await this.prisma.comment.findFirst({
      where: { id: commentId, projectId, deletedAt: null },
    });
    if (comment === null) {
      throw new AppException(COMMENT_ERRORS.notFound, "Comment not found.", HttpStatus.NOT_FOUND);
    }
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { resolvedAt: resolved ? new Date() : null },
    });
    return toView(updated);
  }
}
