import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import { refreshBatch } from "./batch-status.js";
import { ChannelDirectory } from "./channel-directory.js";
import { artifactFingerprint } from "./clip-videos.js";
import { isSupportedProvider, rulesFor, type SupportedProvider } from "./platforms.js";
import { hashtagsIn } from "./post-text.js";
import {
  comparableText,
  postizHtml,
  postizSettings,
  type CanonicalSettings,
} from "./postiz/postiz-format.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { isPostizError, type PostizError } from "./postiz/postiz.errors.js";
import { PublishingAccess } from "./publishing-access.js";
import {
  AFTER_DUE_CHECK_MS,
  AUTO_ATTEMPTS,
  FIRST_CHECK_MS,
  MAX_CHECK_GAP_MS,
  MAX_CHECKS,
  MAX_PROCESSING_MS,
  RETRY_BASE_MS,
  SCHEDULED_CHECK_GAP_MS,
  UNCERTAIN_CHECKS,
} from "./publishing.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE, type ObjectStore } from "../common/storage/index.js";

import type { PostizMedia, PostizPost } from "./postiz/postiz.schemas.js";
import type {
  PublishDispatchPayload,
  PublishErrorCode,
  PublishReconcilePayload,
} from "./publishing.contract.js";
import type { $Enums, Prisma } from "@prisma/client";

/**
 * Sends one confirmed post to Postiz, and finds out what became of it
 * (`publish.dispatch@1` / `publish.reconcile@1`, 2026-09-29).
 *
 * **At most once per attempt, plus reconciliation** (master plan §4.3). Postiz
 * has no idempotency key, so the rule is kept on this side:
 *
 *   1. The row is claimed (`ready` → `validating`) before anything is sent.
 *   2. The video is uploaded once; Postiz's media id is written down BEFORE
 *      the post is created, so a retry reuses it (§12.4 step 4).
 *   3. The row is marked `submitted` BEFORE the create call. A crash or a lost
 *      answer after that point leaves a `submitted` row with no Postiz id,
 *      which is never sent again blindly: the reconciler looks in Postiz for a
 *      post on that channel with that text at that time and adopts it, and
 *      only after several looks find nothing does the post count as never
 *      accepted and go back for another attempt.
 *   4. Postiz's post id is written down the moment it answers.
 *
 * Postiz is the scheduler of record (§12.6): a scheduled post is handed over
 * at confirmation, with its date, so a later edit of the clip does not change
 * what was agreed. The reconciler mirrors what Postiz does with it.
 *
 * Neither method throws: every outcome is written on the row, which is what the
 * page and the watchdog read. A failure to write is logged and left to the
 * watchdog, which finds the row where it was.
 */

const DAY_MS = 24 * 60 * 60_000;
/** A post still `validating` this long after its claim was abandoned by a dead process. */
const STALE_CLAIM_MS = 30 * 60_000;
/** Postiz takes a video of up to 1 GB (`getMaxSize` for `video/*`). */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

const DISPATCH_INCLUDE = {
  channelConnection: true,
  export: {
    select: {
      id: true,
      status: true,
      kind: true,
      storageKey: true,
      bucket: true,
      sizeBytes: true,
    },
  },
  clip: { select: { title: true } },
  variant: { select: { aspect: true } },
} as const satisfies Prisma.PublishTargetInclude;

type DispatchTarget = Prisma.PublishTargetGetPayload<{ include: typeof DISPATCH_INCLUDE }>;

export type DispatchOutcome =
  "missing" | "stale" | "skipped" | "deferred" | "submitted" | "uncertain" | "failed";

export type ReconcileOutcome =
  "missing" | "stale" | "skipped" | "waiting" | "published" | "failed" | "cancelled" | "adopted";

interface Refusal {
  readonly status: Extract<
    $Enums.PublishTargetStatus,
    "failed_permanent" | "failed_retryable" | "action_required"
  >;
  readonly code: PublishErrorCode;
  readonly message: string;
}

/** The post's words as frozen at confirmation (`PostCopySchema`). */
function copyOf(target: { readonly copy: Prisma.JsonValue }): {
  title: string | null;
  body: string;
} {
  const copy =
    typeof target.copy === "object" && target.copy !== null && !Array.isArray(target.copy)
      ? (target.copy as Record<string, unknown>)
      : {};
  return {
    title: typeof copy["title"] === "string" ? copy["title"] : null,
    body: typeof copy["body"] === "string" ? copy["body"] : "",
  };
}

function settingsOf(target: { readonly settings: Prisma.JsonValue }): CanonicalSettings | null {
  const settings = target.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  const provider = (settings as { provider?: unknown }).provider;
  return typeof provider === "string" && isSupportedProvider(provider)
    ? (settings as unknown as CanonicalSettings)
    : null;
}

function httpsOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** A file name Postiz can store: the clip's name and shape, no punctuation surprises. */
function fileNameFor(title: string, aspect: string): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "clip";
  return `${base}-${aspect.replace(/^r/, "")}.mp4`;
}

@Injectable()
export class PublishDispatcher {
  private readonly logger = new Logger(PublishDispatcher.name);
  /** After a 429 from Postiz, no post is created in this process before this instant. */
  private coolDownUntil = 0;

  /** Fields so a test can set the clock and the jitter. */
  now: () => number = () => Date.now();
  random: () => number = () => Math.random();

  constructor(
    private readonly prisma: PrismaService,
    private readonly postiz: PostizClient,
    private readonly directory: ChannelDirectory,
    private readonly access: PublishingAccess,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    @Optional() @Inject(RAW_STORE) private readonly raw?: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // publish.dispatch
  // -------------------------------------------------------------------------

  async dispatch(payload: PublishDispatchPayload): Promise<DispatchOutcome> {
    try {
      return await this.dispatchOnce(payload);
    } catch (error) {
      // Only a database failure lands here: the row stays where it was and the
      // watchdog brings it back.
      this.logger.error(
        { targetId: payload.publishTargetId, err: error },
        "publish dispatch failed to record its outcome",
      );
      return "failed";
    }
  }

  private async dispatchOnce(payload: PublishDispatchPayload): Promise<DispatchOutcome> {
    const now = this.now();
    const target = await this.prisma.publishTarget.findUnique({
      where: { id: payload.publishTargetId },
      include: DISPATCH_INCLUDE,
    });
    if (target === null) return "missing";
    if (target.attemptNo !== payload.attemptNo) return "stale";
    if (target.status !== "ready" && target.status !== "validating") return "skipped";
    if (target.retryAfter !== null && target.retryAfter.getTime() > now) return "deferred";

    const access = await this.access.state(target.workspaceId);
    if (access.reason !== null) {
      await this.refuse(target, {
        status: "action_required",
        code: "publishing/not_approved",
        message:
          access.reason === "flag_off"
            ? "Posting was switched off before this went out. Cancel it, or try again once it is back on."
            : "Posting is not set up any more. See Settings, Publishing, then try again.",
      });
      return "failed";
    }
    if (now < this.coolDownUntil) {
      await this.defer(target, this.coolDownUntil);
      return "deferred";
    }

    const claimed = await this.prisma.publishTarget.updateMany({
      where: {
        id: target.id,
        attemptNo: target.attemptNo,
        OR: [
          { status: "ready" },
          { status: "validating", updatedAt: { lt: new Date(now - STALE_CLAIM_MS) } },
        ],
      },
      data: { status: "validating", updatedAt: new Date(now) },
    });
    if (claimed.count === 0) return "skipped";

    const settings = settingsOf(target);
    const provider = target.provider;
    if (settings === null || !isSupportedProvider(provider)) {
      await this.refuse(target, {
        status: "failed_permanent",
        code: "publishing/validation_failed",
        message: "This post was saved in a form Aksharo can no longer send. Post it again.",
      });
      return "failed";
    }

    const connection = target.channelConnection;
    if (connection === null || connection.connectionStatus === "disconnected") {
      await this.refuse(target, disconnected());
      return "failed";
    }

    let integration;
    try {
      integration = await this.directory.integration(connection.externalIntegrationId);
    } catch (error) {
      await this.refuse(target, this.transient(target, error, "publishing/provider_unavailable"));
      return "failed";
    }
    if (integration === null) {
      await this.refuse(target, disconnected());
      return "failed";
    }
    if (integration.disabled === true) {
      await this.refuse(target, {
        status: "action_required",
        code: "publishing/account_disconnected",
        message: "This account is paused where it was connected. Turn it back on, then try again.",
      });
      return "failed";
    }

    // 1. The video, uploaded once per post.
    let media: PostizMedia | null =
      target.externalMediaId !== null && target.externalMediaPath !== null
        ? { id: target.externalMediaId, path: target.externalMediaPath }
        : null;
    if (media === null) {
      const uploaded = await this.upload(target);
      if (uploaded === null) return "failed";
      media = uploaded;
      await this.prisma.publishTarget.update({
        where: { id: target.id },
        data: { externalMediaId: media.id, externalMediaPath: media.path },
      });
    }

    // 2. The post: marked submitted first, so a lost answer is looked for, not re-sent.
    const copy = copyOf(target);
    const submittedAt = new Date(this.now());
    await this.prisma.publishTarget.update({
      where: { id: target.id },
      data: {
        status: "submitted",
        submittedAt,
        checkNo: 0,
        nextCheckAt: new Date(submittedAt.getTime() + FIRST_CHECK_MS),
      },
    });

    const scheduledAt = target.scheduledAt;
    try {
      const { postId } = await this.postiz.createPost({
        type: scheduledAt === null ? "now" : "schedule",
        date: scheduledAt ?? submittedAt,
        integrationId: integration.id,
        identifier: integration.identifier,
        contentHtml: postizHtml(copy.body),
        media,
        settings: postizSettings(settings, { title: copy.title, hashtags: hashtagsIn(copy.body) }),
      });
      const at = this.now();
      const waiting = scheduledAt !== null && scheduledAt.getTime() > at + 60_000;
      await this.prisma.publishTarget.update({
        where: { id: target.id },
        data: {
          externalPostId: postId,
          externalStatus: "QUEUE",
          status: waiting ? "scheduled" : "processing",
          checkNo: 0,
          nextCheckAt: new Date(
            waiting ? scheduledCheckAt(scheduledAt.getTime(), at) : at + FIRST_CHECK_MS,
          ),
          lastErrorCode: null,
          lastErrorSafeMessage: null,
          retryAfter: null,
        },
      });
      await refreshBatch(this.prisma, target.batchId);
      this.logger.log(
        { targetId: target.id, provider, scheduled: waiting },
        "post handed to the publishing service",
      );
      return "submitted";
    } catch (error) {
      if (isPostizError(error) && error.uncertain) {
        // It may have gone through: the reconciler finds out, nothing re-sends it.
        await this.prisma.publishTarget.update({
          where: { id: target.id },
          data: {
            lastErrorCode: "publishing/uncertain_outcome",
            lastErrorSafeMessage: "Checking whether the post went through.",
          },
        });
        this.logger.warn(
          { targetId: target.id, kind: error.kind, status: error.status },
          "post create answer lost; reconciling before anything is sent again",
        );
        return "uncertain";
      }
      if (isPostizError(error) && error.kind === "rate_limited") {
        // Not accepted: Postiz's hourly limit. Every post waits, none spends an attempt.
        this.coolDownUntil = this.now() + (error.retryAfterMs ?? 15 * 60_000);
        await this.defer(target, this.coolDownUntil);
        this.logger.warn(
          { targetId: target.id, retryAfterMs: error.retryAfterMs },
          "Postiz's post limit reached; posts wait for it",
        );
        return "deferred";
      }
      await this.refuse(target, this.refusalOf(target, provider, error));
      return "failed";
    }
  }

  /** Stream the frozen export into Postiz. Null when it could not be, with the row updated. */
  private async upload(target: DispatchTarget): Promise<PostizMedia | null> {
    const video = target.export;
    if (
      video === null ||
      video.status !== "succeeded" ||
      video.kind !== "mp4" ||
      video.storageKey === null ||
      video.storageKey === ""
    ) {
      await this.refuse(target, stale("The video is no longer stored. Make it again, then post."));
      return null;
    }
    const sizeBytes = video.sizeBytes === null ? null : Number(video.sizeBytes);
    const fingerprint = artifactFingerprint({
      id: video.id,
      storageKey: video.storageKey,
      sizeBytes,
    });
    if (fingerprint !== target.artifactFingerprint) {
      await this.refuse(
        target,
        stale("The video changed after this post was confirmed. Post it again."),
      );
      return null;
    }
    if (sizeBytes !== null && sizeBytes > MAX_UPLOAD_BYTES) {
      await this.refuse(target, {
        status: "failed_permanent",
        code: "publishing/media_rejected",
        message: "The video is larger than 1 GB, which is more than can be posted.",
      });
      return null;
    }

    const store = video.bucket === "s3" ? this.raw : this.derived;
    if (store?.openRead === undefined) {
      await this.refuse(target, stale("The video cannot be read on this server."));
      return null;
    }
    let file;
    try {
      file = await store.openRead(video.storageKey);
    } catch (error) {
      const missing =
        typeof error === "object" &&
        error !== null &&
        ((error as { name?: unknown }).name === "NoSuchKey" ||
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);
      await this.refuse(
        target,
        missing
          ? stale("The video is no longer stored. Make it again, then post.")
          : this.transient(target, error, "publishing/provider_unavailable"),
      );
      return null;
    }

    try {
      return await this.postiz.uploadVideo({
        body: file.body,
        filename: fileNameFor(target.clip.title, target.variant.aspect),
        sizeBytes: file.sizeBytes ?? sizeBytes,
      });
    } catch (error) {
      await file.body.cancel().catch(() => undefined);
      // An upload is safe to send again whatever happened: at worst Postiz keeps
      // an unused copy. So "uncertain" is just "try again" here.
      await this.refuse(
        target,
        isPostizError(error) && !error.transient && !error.uncertain
          ? this.refusalOf(target, target.provider as SupportedProvider, error)
          : this.transient(target, error, "publishing/provider_unavailable"),
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // publish.reconcile
  // -------------------------------------------------------------------------

  async reconcile(payload: PublishReconcilePayload): Promise<ReconcileOutcome> {
    try {
      return await this.reconcileOnce(payload);
    } catch (error) {
      this.logger.error(
        { targetId: payload.publishTargetId, err: error },
        "publish reconcile failed to record its outcome",
      );
      return "waiting";
    }
  }

  /** One check now, outside the queue: cancel asks this before deleting. */
  async checkNow(targetId: string): Promise<ReconcileOutcome> {
    const target = await this.prisma.publishTarget.findUnique({ where: { id: targetId } });
    if (target === null) return "missing";
    return this.reconcile({
      schemaVersion: 1,
      publishTargetId: targetId,
      checkNo: target.checkNo + 1,
    });
  }

  private async reconcileOnce(payload: PublishReconcilePayload): Promise<ReconcileOutcome> {
    const target = await this.prisma.publishTarget.findUnique({
      where: { id: payload.publishTargetId },
      include: { channelConnection: true },
    });
    if (target === null) return "missing";
    if (
      target.status !== "submitted" &&
      target.status !== "processing" &&
      target.status !== "scheduled"
    ) {
      return "skipped";
    }
    // Jobs are keyed by check number: an old or duplicate one does nothing.
    if (payload.checkNo !== target.checkNo + 1) return "stale";
    const checkNo = target.checkNo + 1;
    const now = this.now();

    let found: PostizPost | null;
    try {
      found = await this.findPost(target, now);
    } catch (error) {
      // Postiz did not answer: nothing is known, so nothing changes but the next look.
      await this.nextCheck(target.id, checkNo, now + checkGap(checkNo));
      this.logger.warn(
        { targetId: target.id, kind: isPostizError(error) ? error.kind : "unknown" },
        "could not ask the publishing service about a post; asking again later",
      );
      return "waiting";
    }

    if (target.externalPostId === null) {
      if (found === null) {
        if (checkNo < UNCERTAIN_CHECKS) {
          await this.nextCheck(target.id, checkNo, now + checkGap(checkNo));
          return "waiting";
        }
        // Looked for several times and not there: it was never accepted.
        await this.refuse(
          target,
          this.transient(target, null, "publishing/uncertain_outcome"),
          checkNo,
        );
        return "failed";
      }
      const claimedBy = await this.prisma.publishTarget.findFirst({
        where: { externalPostId: found.id, provider: target.provider, id: { not: target.id } },
        select: { id: true },
      });
      if (claimedBy !== null) {
        await this.nextCheck(target.id, checkNo, now + checkGap(checkNo));
        return "waiting";
      }
      await this.prisma.publishTarget.update({
        where: { id: target.id },
        data: { externalPostId: found.id, lastErrorCode: null, lastErrorSafeMessage: null },
      });
    }

    if (found === null) {
      // Gone from Postiz entirely: deleted there, by hand.
      await this.settle(target, {
        status: "cancelled",
        externalStatus: "deleted",
        nextCheckAt: null,
        checkNo,
        lastErrorCode: null,
        lastErrorSafeMessage: "It was deleted where it was scheduled.",
      });
      return "cancelled";
    }

    const state = found.state.toUpperCase();
    if (state === "PUBLISHED") {
      await this.settle(target, {
        status: "published",
        externalPostId: found.id,
        externalStatus: state,
        externalUrl: httpsOrNull(found.releaseURL),
        publishedAt: new Date(now),
        nextCheckAt: null,
        checkNo,
        lastErrorCode: null,
        lastErrorSafeMessage: null,
      });
      this.logger.log({ targetId: target.id, provider: target.provider }, "post published");
      return "published";
    }
    if (state === "ERROR") {
      await this.settle(target, {
        status: "failed_retryable",
        externalStatus: state,
        nextCheckAt: null,
        checkNo,
        retryAfter: null,
        lastErrorCode: "publishing/provider_unavailable",
        lastErrorSafeMessage: `${labelOf(target.provider)} did not take the post. Check the account where it is connected, then try again.`,
      });
      return "failed";
    }
    if (state === "DRAFT") {
      await this.settle(target, {
        status: "action_required",
        externalStatus: state,
        nextCheckAt: null,
        checkNo,
        lastErrorCode: "publishing/not_approved",
        lastErrorSafeMessage:
          "It was turned into a draft where it was scheduled. Publish it there, or cancel it here.",
      });
      return "failed";
    }

    // Still waiting in Postiz (QUEUE).
    const publishAt = Date.parse(found.publishDate);
    const scheduledAt =
      target.publishMode === "schedule" && Number.isFinite(publishAt)
        ? new Date(publishAt)
        : target.scheduledAt;
    const due = (scheduledAt ?? target.submittedAt ?? target.createdAt).getTime();
    if (due > now + 60_000) {
      await this.settle(target, {
        status: "scheduled",
        externalStatus: state,
        // Moved in Postiz's calendar: mirror it, so the page says the real time.
        ...(scheduledAt === null ? {} : { scheduledAt }),
        checkNo,
        nextCheckAt: new Date(scheduledCheckAt(due, now)),
      });
      return "waiting";
    }
    if (now - due > MAX_PROCESSING_MS || checkNo >= MAX_CHECKS) {
      await this.settle(target, {
        status: "action_required",
        externalStatus: state,
        nextCheckAt: null,
        checkNo,
        lastErrorCode: "publishing/uncertain_outcome",
        lastErrorSafeMessage:
          "It has not gone out yet. Check it where your accounts are connected, or cancel it here.",
      });
      return "failed";
    }
    await this.settle(target, {
      status: "processing",
      externalStatus: state,
      checkNo,
      nextCheckAt: new Date(now + checkGap(checkNo)),
    });
    return "waiting";
  }

  /**
   * The post in Postiz: by its id when Postiz answered with one, or - for a
   * submit whose answer was lost - by channel, words and time.
   */
  private async findPost(
    target: {
      readonly id: string;
      readonly externalPostId: string | null;
      readonly scheduledAt: Date | null;
      readonly submittedAt: Date | null;
      readonly createdAt: Date;
      readonly copy: Prisma.JsonValue;
      readonly channelConnection: { readonly externalIntegrationId: string } | null;
    },
    now: number,
  ): Promise<PostizPost | null> {
    const anchor = (target.scheduledAt ?? target.submittedAt ?? target.createdAt).getTime();
    const near = await this.postiz.listPosts(new Date(anchor - DAY_MS), new Date(anchor + DAY_MS));
    if (target.externalPostId === null) {
      const integrationId = target.channelConnection?.externalIntegrationId;
      if (integrationId === undefined) return null;
      const words = comparableText(postizHtml(copyOf(target).body));
      const tolerance = target.scheduledAt === null ? 10 * 60_000 : 2 * 60_000;
      return (
        near.find(
          (post) =>
            post.integration?.id === integrationId &&
            comparableText(post.content ?? "") === words &&
            Math.abs(Date.parse(post.publishDate) - anchor) <= tolerance,
        ) ?? null
      );
    }
    const byId = near.find((post) => post.id === target.externalPostId);
    if (byId !== undefined) return byId;
    // Not near its time: moved in the calendar, or deleted. Look wide before deciding.
    const wide = await this.postiz.listPosts(
      new Date(Math.min(anchor, target.createdAt.getTime()) - 2 * DAY_MS),
      new Date(now + 400 * DAY_MS),
    );
    return wide.find((post) => post.id === target.externalPostId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------

  /** A passing failure: tried again by itself while attempts remain, else it waits for Retry. */
  private transient(
    target: { readonly attemptNo: number },
    error: unknown,
    code: PublishErrorCode,
  ): Refusal & { readonly retryAfterMs: number | null } {
    const auto = target.attemptNo < AUTO_ATTEMPTS;
    const delay = Math.round(
      RETRY_BASE_MS * 2 ** Math.max(0, target.attemptNo - 1) * (0.8 + 0.4 * this.random()),
    );
    if (error !== null) {
      this.logger.warn(
        {
          kind: isPostizError(error) ? error.kind : "storage",
          status: isPostizError(error) ? error.status : null,
        },
        "posting hit a passing failure",
      );
    }
    return {
      status: "failed_retryable",
      code,
      message:
        code === "publishing/uncertain_outcome"
          ? auto
            ? "The post did not go through. It will be tried again shortly."
            : "The post did not go through. Try again."
          : auto
            ? "The publishing service was not reachable. It will be tried again shortly."
            : "The publishing service was not reachable. Try again in a few minutes.",
      retryAfterMs: auto ? delay : null,
    };
  }

  /** Postiz said no, for a reason that sending the same thing again will not fix. */
  private refusalOf(
    target: { readonly attemptNo: number },
    provider: SupportedProvider,
    error: unknown,
  ): Refusal & { readonly retryAfterMs?: number | null } {
    if (!isPostizError(error))
      return this.transient(target, error, "publishing/provider_unavailable");
    const label = rulesFor(provider).label;
    switch (error.kind) {
      case "unauthorized":
      case "forbidden":
        return {
          status: "action_required",
          code: "publishing/permission_missing",
          message:
            "The publishing service refused Aksharo's key. Check Settings, Publishing, then try again.",
        };
      case "not_configured":
        return {
          status: "action_required",
          code: "publishing/not_approved",
          message: "Posting is not set up any more. See Settings, Publishing, then try again.",
        };
      case "too_large":
        return {
          status: "failed_permanent",
          code: "publishing/media_rejected",
          message: "The video is too large to post.",
        };
      case "not_found":
        // A route Postiz does not have: the address is wrong, not the post.
        return {
          status: "action_required",
          code: "publishing/permission_missing",
          message:
            "The publishing service did not recognise the request. Check its address in Settings, Publishing.",
        };
      case "bad_request":
        return this.badRequest(label, error);
      default:
        return this.transient(target, error, "publishing/provider_unavailable");
    }
  }

  /** Postiz's own refusal (never shown), as the sentence a person can act on. */
  private badRequest(label: string, error: PostizError): Refusal {
    const detail = (error.detail ?? "").toLowerCase();
    this.logger.warn(
      { status: error.status, detail: error.detail },
      "the publishing service refused a post",
    );
    if (detail.includes("too long")) {
      return {
        status: "failed_permanent",
        code: "publishing/validation_failed",
        message: `The text is too long for ${label}. Shorten it and post again.`,
      };
    }
    if (detail.includes("at least one character") || detail.includes("content must be")) {
      return {
        status: "failed_permanent",
        code: "publishing/validation_failed",
        message: "The post needs some text. Post it again with a few words.",
      };
    }
    if (detail.includes("integration") && detail.includes("not found")) return disconnected();
    if (detail.includes("title")) {
      return {
        status: "failed_permanent",
        code: "publishing/validation_failed",
        message: `${label} refused the title. Use 2 to 100 characters and post again.`,
      };
    }
    if (/(file|media|extension|mime|unsupported)/.test(detail)) {
      return {
        status: "failed_permanent",
        code: "publishing/media_rejected",
        message: `${label} could not use this video.`,
      };
    }
    if (detail.includes("subscription")) {
      return {
        status: "action_required",
        code: "publishing/permission_missing",
        message: "The publishing service's plan does not allow this post.",
      };
    }
    return {
      status: "failed_permanent",
      code: "publishing/content_rejected",
      message: `${label} refused this post. Check the text and post again.`,
    };
  }

  private async refuse(
    target: { readonly id: string; readonly batchId: string; readonly provider: string },
    refusal: Refusal & { readonly retryAfterMs?: number | null },
    checkNo?: number,
  ): Promise<void> {
    const now = this.now();
    await this.settle(target, {
      status: refusal.status,
      lastErrorCode: refusal.code,
      lastErrorSafeMessage: refusal.message,
      retryAfter:
        refusal.retryAfterMs === undefined || refusal.retryAfterMs === null
          ? null
          : new Date(now + refusal.retryAfterMs),
      nextCheckAt: null,
      ...(checkNo === undefined ? {} : { checkNo }),
    });
    this.logger.log(
      {
        targetId: target.id,
        provider: target.provider,
        status: refusal.status,
        code: refusal.code,
      },
      "post not sent",
    );
  }

  /** Back to `ready`, not before `until`, without spending an attempt. */
  private async defer(target: { readonly id: string }, until: number): Promise<void> {
    await this.prisma.publishTarget.update({
      where: { id: target.id },
      data: {
        status: "ready",
        retryAfter: new Date(until),
        lastErrorCode: "publishing/rate_limited",
        lastErrorSafeMessage: "Waiting for a free posting slot.",
      },
    });
  }

  private async nextCheck(targetId: string, checkNo: number, at: number): Promise<void> {
    await this.prisma.publishTarget.update({
      where: { id: targetId },
      data: { checkNo, nextCheckAt: new Date(at) },
    });
  }

  private async settle(
    target: { readonly id: string; readonly batchId: string },
    data: Prisma.PublishTargetUpdateInput,
  ): Promise<void> {
    await this.prisma.publishTarget.update({ where: { id: target.id }, data });
    await refreshBatch(this.prisma, target.batchId);
  }
}

function disconnected(): Refusal {
  return {
    status: "action_required",
    code: "publishing/account_disconnected",
    message: "This account is no longer connected. Connect it again, then try again.",
  };
}

function stale(message: string): Refusal {
  return { status: "failed_permanent", code: "publishing/artifact_stale", message };
}

function labelOf(provider: string): string {
  return isSupportedProvider(provider) ? rulesFor(provider).label : "The platform";
}

/** The gap before check `checkNo` of a post going out: 30 s, doubling, at most 10 min. */
export function checkGap(checkNo: number): number {
  return Math.min(FIRST_CHECK_MS * 2 ** Math.max(0, checkNo - 1), MAX_CHECK_GAP_MS);
}

/**
 * When to look at a post scheduled for `due`: right after its time, and until
 * then at most every day - an eighth of the wait, so a post a year ahead costs
 * a few dozen looks, not hundreds.
 */
export function scheduledCheckAt(due: number, now: number): number {
  const gap = Math.max(SCHEDULED_CHECK_GAP_MS, Math.round((due - now) / 8));
  return Math.min(due + AFTER_DUE_CHECK_MS, now + gap);
}
