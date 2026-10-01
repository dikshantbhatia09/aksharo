import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import type { Env } from "@montaj/config";

import {
  AUTOPILOT_RETRY_WITHIN_MS,
  AUTOPILOT_RUN_RETRIES,
  AUTOPILOT_RUN_RETRY_CODES,
  PRE_CANDIDATE_STATUSES,
  REPURPOSE_FLAGS,
  autopilotRetriesOf,
  automationOf,
} from "./repurpose.constants.js";
import { cleanSourceTitle } from "./repurpose.projection.js";
import { RepurposeService, isUniqueViolation } from "./repurpose.service.js";
import { RunActivityReader } from "./run-activity.reader.js";
import { SourceGate } from "./source-gate.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { ENV } from "../config/config.module.js";
import { NotifyService } from "../notify/notify.service.js";

import type { ClipsProgress } from "./run-activity.js";
import type { NotifyData } from "../notify/notify.types.js";
import type { $Enums } from "@prisma/client";

/**
 * "Tell me when my clips are ready" (2026-09-29): a run's notifications, each
 * sent once, to the person who started it — in the bell, by email (logged
 * only while production mail is `dev`), and to every browser they turned
 * device notifications on in (Web Push, `notify/push`).
 *
 *   * `clips-ready` — the first clips can be watched: on Autopilot, the first
 *     captioned video; otherwise the first clip whose own video is prepared.
 *   * `run-complete` — Autopilot only: every clip, its sizes and its images
 *     are made (or given up on), and nothing is still being made.
 *   * `run-failed` — the run stopped for good: not a failure Autopilot is about
 *     to try again by itself (`retryAutopilotRuns`).
 *   * `run-needs-you` — the next step is the person's: out of credits, YouTube
 *     keeps refusing the download (upload the file instead), or the moments are
 *     theirs to pick (or add, when none were found).
 *
 * **Decided from durable state, like the run itself** (`reconciler.ts`): a
 * pass over the runs that could be due, from the reconciler's own watchdog, so
 * nothing needs a page open and no producer has to remember to call this.
 * {@link dueNotices} is the decision, pure and tested.
 *
 * **Once per run and kind** (`repurpose_run_notices`): a notice is claimed —
 * a row inserted under the table's primary key — BEFORE it is sent, and only
 * the pass whose insert lands sends it. Two passes, or two API processes, can
 * both see a run due; one claims it. The price is at-most-once: a process that
 * dies between the claim and the send loses that one message, where the other
 * order would repeat it. Never on the run row itself: writing the run moves
 * its `updated_at`, which the reconciler reads as "answered every job that
 * ended before this" (`unansweredFactsOf`).
 *
 * Runs from before this existed were marked as told by the migration
 * (`20261001120000_progress_alerts`), so a deploy sends no backlog.
 */

/** The claims: a notice kind, and for `run-needs-you` which need it was. */
export const RUN_NOTICES = [
  "clips-ready",
  "run-complete",
  "run-failed",
  "run-needs-you:credits",
  "run-needs-you:upload",
  "run-needs-you:moments",
] as const;
export type RunNotice = (typeof RUN_NOTICES)[number];

/**
 * How long after a run failed its failure is still news. A run is looked at
 * every 30 s, so this only matters for an API that was down: past it, the
 * person has long since found out.
 */
export const FAILED_NEWS_MS = 6 * 60 * 60_000;
/** The most runs one pass looks at, newest first (the reconciler's own bound). */
const SWEEP_MAX_RUNS = 200;
/**
 * A run still open this long after it started is not going to be "ready" in a
 * way anyone is waiting on a buzz for; it is left out of the pass, which keeps
 * a run that never settles from being re-read every 30 s for good.
 */
export const LIVE_NEWS_MS = 7 * 24 * 60 * 60_000;
/**
 * YouTube refusals of one run's download before it is worth telling the
 * person they can upload the file instead: the second, so a one-off refusal
 * the run gets past by itself stays quiet. The third fails the run
 * (`MAX_BLOCKED_FETCHES`), which says the same thing — once, as one claim.
 */
export const REFUSALS_BEFORE_UPLOAD_NOTICE = 2;

/** Statuses a run can be due a notice in, besides a recent failure. */
const LIVE_STATUSES: readonly $Enums.RepurposeRunStatus[] = [
  ...PRE_CANDIDATE_STATUSES,
  "candidates_ready",
  "materializing",
  "rendering",
  "review_ready",
  "changes_requested",
  "approved",
];

/** What the decision reads. */
export interface NoticeFacts {
  readonly now: number;
  readonly status: $Enums.RepurposeRunStatus;
  readonly failureCode: string | null;
  readonly automation: "auto" | "manual";
  /** `config.autopilotRetries`: how many times Autopilot has tried the run again. */
  readonly autopilotRetries: number;
  /** When it failed (`completed_at`), for Autopilot's retry window. */
  readonly failedAt: number | null;
  readonly candidateCount: number;
  /** Null when not read: the run has no moments yet. */
  readonly clips: Pick<
    ClipsProgress,
    "total" | "ready" | "usable" | "cutting" | "waiting" | "captioned" | "formats" | "images"
  > | null;
  /** The run's download keeps being refused and it is waiting for YouTube. */
  readonly sourceKeepsRefusing: boolean;
}

export interface DueNotice {
  readonly notice: RunNotice;
  /** False: claim it without sending, because a later notice already says it. */
  readonly send: boolean;
  /** The template's variables beyond the run's own. */
  readonly data: NotifyData;
}

/** Autopilot tries this failure again by itself, soon (`retryAutopilotRuns`). */
function autopilotWillRetry(facts: NoticeFacts): boolean {
  return (
    facts.automation === "auto" &&
    facts.failureCode !== null &&
    (AUTOPILOT_RUN_RETRY_CODES as readonly string[]).includes(facts.failureCode) &&
    facts.autopilotRetries < AUTOPILOT_RUN_RETRIES &&
    facts.failedAt !== null &&
    facts.now - facts.failedAt < AUTOPILOT_RETRY_WITHIN_MS
  );
}

/** Every clip, its captioned video, its sizes and its images: made or given up on. */
function everythingMade(clips: NonNullable<NoticeFacts["clips"]>): boolean {
  return (
    clips.ready > 0 &&
    clips.cutting + clips.waiting === 0 &&
    clips.captioned.settled >= clips.ready &&
    clips.formats.settled >= clips.formats.total &&
    clips.images.settled >= clips.images.total
  );
}

/**
 * The notices `facts` make due that `sent` does not already hold. Pure: the
 * pass reads, claims and sends; this decides.
 */
export function dueNotices(facts: NoticeFacts, sent: ReadonlySet<string>): DueNotice[] {
  const due: DueNotice[] = [];
  const add = (notice: RunNotice, data: NotifyData = {}, send = true): void => {
    if (!sent.has(notice) && !due.some((entry) => entry.notice === notice)) {
      due.push({ notice, send, data });
    }
  };

  switch (facts.status) {
    case "cancelled":
    case "publishing":
    case "partially_published":
    case "published":
      return due;
    case "failed":
      if (facts.failureCode === "repurpose/no_credits") {
        add("run-needs-you:credits", { reason: "credits" });
      } else if (facts.failureCode === "repurpose/source_blocked") {
        add("run-needs-you:upload", { reason: "upload" });
      } else if (!autopilotWillRetry(facts)) {
        add("run-failed");
      }
      return due;
    default:
      break;
  }

  if ((PRE_CANDIDATE_STATUSES as readonly string[]).includes(facts.status)) {
    if (facts.sourceKeepsRefusing) add("run-needs-you:upload", { reason: "upload" });
    return due;
  }

  const clips = facts.clips;
  if (
    facts.status === "candidates_ready" &&
    (clips === null || clips.total === 0) &&
    (facts.automation === "manual" || facts.candidateCount === 0)
  ) {
    add("run-needs-you:moments", { reason: facts.candidateCount > 0 ? "moments" : "add" });
  }
  if (clips === null) return due;

  const auto = facts.automation === "auto";
  if (auto && facts.status === "review_ready" && everythingMade(clips)) {
    // One message says it all: a run that finished between two passes is not
    // told "your first clips are ready" and "everything is ready" at once.
    add("clips-ready", {}, false);
    add("run-complete", { count: clips.ready });
    return due;
  }
  const watchable = auto ? clips.captioned.ready : clips.usable;
  if (watchable > 0) add("clips-ready", { count: watchable });
  return due;
}

interface Recipient {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly locale: string;
}

/**
 * Sends a run's notifications (see the module comment). One public method,
 * {@link sweep}, called from the reconciler's watchdog; it never throws.
 */
@Injectable()
export class RunNotifier {
  private readonly logger = new Logger(RunNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly activity: RunActivityReader,
    private readonly notify: NotifyService,
    @Inject(ENV) private readonly env: Env,
    /** YouTube's circuit breaker; absent in harnesses (never open there). */
    @Optional() private readonly gate?: SourceGate,
  ) {}

  /** One pass over the runs that could be due a notice. Never throws. */
  async sweep(now: number = Date.now()): Promise<void> {
    try {
      await this.pass(now);
    } catch (error) {
      this.logger.warn({ err: error }, "run notifications pass failed; the next one retries");
    }
  }

  private async pass(now: number): Promise<void> {
    const runs = await this.prisma.repurposeRun.findMany({
      where: {
        OR: [
          { status: { in: [...LIVE_STATUSES] }, createdAt: { gte: new Date(now - LIVE_NEWS_MS) } },
          { status: "failed", completedAt: { gte: new Date(now - FAILED_NEWS_MS) } },
          // A writer that fails a run without stamping `completed_at` (the
          // scheduled stuck-runs sweep): the row's own last write is when.
          {
            status: "failed",
            completedAt: null,
            updatedAt: { gte: new Date(now - FAILED_NEWS_MS) },
          },
        ],
      },
      orderBy: { id: "desc" },
      take: SWEEP_MAX_RUNS,
      include: {
        notices: { select: { kind: true } },
        sourceProject: { select: { title: true } },
        _count: { select: { candidates: true } },
      },
    });
    if (runs.length === 0) return;

    const gateOpen =
      this.gate === undefined ? false : ((await this.gate.state(now)).openUntil ?? 0) > now;
    const flows = new Map<string, boolean>();

    for (const run of runs) {
      const sent = new Set(run.notices.map((notice) => notice.kind));
      const auto = automationOf(run) === "auto";
      const early = (PRE_CANDIDATE_STATUSES as readonly string[]).includes(run.status);
      // What this run could still be told, from its row alone: most runs,
      // most passes, need no further read at all.
      const open =
        run.status === "failed"
          ? !["run-failed", "run-needs-you:credits", "run-needs-you:upload"].every((kind) =>
              sent.has(kind),
            )
          : early
            ? gateOpen && run.sourceKind !== "upload" && !sent.has("run-needs-you:upload")
            : !sent.has("clips-ready") ||
              (auto && !sent.has("run-complete")) ||
              (run.status === "candidates_ready" && !sent.has("run-needs-you:moments"));
      if (!open) continue;

      let flow = flows.get(run.workspaceId);
      if (flow === undefined) {
        flow = await this.flowEnabled(run.workspaceId);
        flows.set(run.workspaceId, flow);
      }
      if (!flow) continue;

      try {
        const facts: NoticeFacts = {
          now,
          status: run.status,
          failureCode: run.failureCode,
          automation: auto ? "auto" : "manual",
          autopilotRetries: autopilotRetriesOf(run),
          failedAt: run.completedAt?.getTime() ?? null,
          candidateCount: run._count.candidates,
          clips:
            run.status === "failed" || early ? null : await this.activity.clipsProgress(run, now),
          sourceKeepsRefusing:
            early && gateOpen && run.sourceKind !== "upload"
              ? (await this.runs.blockedFetches(run)) >= REFUSALS_BEFORE_UPLOAD_NOTICE
              : false,
        };
        for (const notice of dueNotices(facts, sent)) {
          await this.deliver(run, notice);
        }
      } catch (error) {
        this.logger.warn({ runId: run.id, err: error }, "could not work out a run's notifications");
      }
    }
  }

  /** Claim `notice` for the run, and send it if this pass is the one that did. */
  private async deliver(
    run: {
      readonly id: string;
      readonly workspaceId: string;
      readonly createdBy: string | null;
      readonly sourceTitle: string | null;
      readonly sourceProject: { readonly title: string } | null;
    },
    notice: DueNotice,
  ): Promise<void> {
    if (!(await this.claim(run.id, notice.notice)) || !notice.send) return;

    const recipient = await this.recipientFor(run);
    if (recipient === null) {
      this.logger.warn(
        { runId: run.id, notice: notice.notice },
        "a run notification has nobody to go to",
      );
      return;
    }
    // A workspace's very first clips get their own words: what was made and what to do next.
    const first = notice.notice === "clips-ready" && (await this.firstClipsReady(run));
    const video = cleanSourceTitle(run.sourceTitle) ?? cleanSourceTitle(run.sourceProject?.title);
    const link = new URL(`/repurpose/${run.id}`, this.env.WEB_ORIGIN).toString();
    const kind = notice.notice.startsWith("run-needs-you")
      ? ("run-needs-you" as const)
      : (notice.notice as "clips-ready" | "run-complete" | "run-failed");
    try {
      await this.notify.enqueue({
        kind,
        to: recipient.email,
        locale: recipient.locale,
        userId: recipient.id,
        workspaceId: run.workspaceId,
        data: {
          ...notice.data,
          ...(first ? { first: "yes" } : {}),
          // Absent, each language's own "there" / "your video" is used.
          ...(recipient.name === null || recipient.name.trim() === ""
            ? {}
            : { name: recipient.name }),
          ...(video === null ? {} : { video: video.slice(0, 80) }),
          runId: run.id,
          link,
        },
        idempotencyKey: `${notice.notice}:${run.id}`,
        thread: run.id,
      });
      this.logger.log({ runId: run.id, notice: notice.notice }, "run notification sent");
    } catch (error) {
      this.logger.warn(
        { runId: run.id, notice: notice.notice, err: error },
        "run notification not sent",
      );
    }
  }

  /**
   * Whether no other run of this workspace was ever told its clips were ready
   * (2026-10-01, OpusClip's first-project messages). Runs from before notices
   * existed were marked as told by their migration, so only a new workspace's
   * first run reads as first. A failed read is "not first": the ordinary words.
   */
  private async firstClipsReady(run: {
    readonly id: string;
    readonly workspaceId: string;
  }): Promise<boolean> {
    try {
      const earlier = await this.prisma.repurposeRunNotice.count({
        where: {
          kind: "clips-ready",
          runId: { not: run.id },
          run: { workspaceId: run.workspaceId },
        },
      });
      return earlier === 0;
    } catch {
      return false;
    }
  }

  /** True when this call inserted the claim; false when another pass already had. */
  private async claim(runId: string, kind: RunNotice): Promise<boolean> {
    try {
      await this.prisma.repurposeRunNotice.create({ data: { runId, kind } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Who started the run, while they are still an active member of its
   * workspace; else the workspace's owner. Never someone who has left: news
   * about a workspace's video is the workspace's.
   */
  private async recipientFor(run: {
    readonly workspaceId: string;
    readonly createdBy: string | null;
  }): Promise<Recipient | null> {
    const select = { id: true, email: true, name: true, locale: true } as const;
    if (run.createdBy !== null) {
      const creator = await this.prisma.user.findFirst({
        where: {
          id: run.createdBy,
          deletedAt: null,
          memberships: { some: { workspaceId: run.workspaceId, status: "active" } },
        },
        select,
      });
      if (creator !== null) return creator;
    }
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: run.workspaceId, deletedAt: null },
      select: { owner: { select: { ...select, deletedAt: true } } },
    });
    const owner = workspace?.owner;
    if (owner === undefined || owner.deletedAt !== null) return null;
    return { id: owner.id, email: owner.email, name: owner.name, locale: owner.locale };
  }

  private async flowEnabled(workspaceId: string): Promise<boolean> {
    try {
      return await this.runs.flagEnabled(workspaceId, REPURPOSE_FLAGS.flow);
    } catch {
      return false;
    }
  }
}
