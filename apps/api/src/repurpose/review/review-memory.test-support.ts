/* eslint-disable security/detect-object-injection -- a test fake indexing its own rows by field name */
import type { Env } from "@montaj/config";

import { ClientReviewService } from "./client-review.service.js";
import { ClipApprovalGate } from "./clip-approval.gate.js";
import { ClipReviewService } from "./clip-review.service.js";
import { ReviewNotifier } from "./review-notifier.js";

import type { CommonAuditEvent, CommonAuditService } from "../../common/audit/audit.service.js";
import type { RateLimitService } from "../../common/guards/index.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { NotifyService } from "../../notify/notify.service.js";
import type { NotifyEnqueueInput } from "../../notify/notify.types.js";
import type { EntitlementService } from "../../workspaces/entitlement.service.js";

/**
 * An in-memory stand-in for the slice of Prisma clip review uses, for its unit
 * tests (no database, no Docker), in the manner of the publishing module's
 * `memory-prisma.test-support.ts`.
 *
 * It understands the query shapes the review module sends: equality, `in`,
 * `not`, `lt`/`lte`/`gt`/`gte`, `AND`/`OR`, JSON `path` + `equals`, and the
 * relation filters and selections it uses (`run: { workspaceId }`,
 * `memberships: { some }`, a clip's `candidate`, a variant's `latestExport` and
 * project exports, a run's `sourceProject`, a workspace's `owner`). It enforces
 * the one rule the review leans on: `clip_reviews.clip_id` is a primary key.
 * Guest pages (2026-10-05) use it too, with the tables they read added.
 *
 * Not a test file; only ever imported by the review tests.
 */

export type Row = Record<string, unknown>;

export interface ReviewTables {
  workspace: Row[];
  user: Row[];
  membership: Row[];
  project: Row[];
  repurposeRun: Row[];
  clipCandidate: Row[];
  repurposeClip: Row[];
  clipVariant: Row[];
  export: Row[];
  clipReview: Row[];
  clipReviewEvent: Row[];
  clipComment: Row[];
  clipReviewLink: Row[];
  notification: Row[];
  /** Guest pages (2026-10-05, `repurpose/guest`) read these too. */
  clipGuestLink: Row[];
  mediaAsset: Row[];
  clipDub: Row[];
  clipDubVariant: Row[];
  llmOutput: Row[];
}

function compare(value: unknown, other: unknown): number {
  const a = value instanceof Date ? value.getTime() : (value as number);
  const b = other instanceof Date ? other.getTime() : (other as number);
  return a < b ? -1 : a > b ? 1 : 0;
}

function same(value: unknown, other: unknown): boolean {
  if (value instanceof Date && other instanceof Date) return value.getTime() === other.getTime();
  return value === other;
}

function isOperatorObject(condition: unknown): condition is Row {
  return (
    condition !== null &&
    typeof condition === "object" &&
    !(condition instanceof Date) &&
    !Array.isArray(condition)
  );
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return same(value, condition);
  if ("path" in condition) {
    let at: unknown = value;
    for (const key of condition["path"] as string[]) {
      at = at !== null && typeof at === "object" ? (at as Row)[key] : undefined;
    }
    return same(at, condition["equals"]);
  }
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case "in":
        if (!(operand as unknown[]).some((entry) => same(value, entry))) return false;
        break;
      case "notIn":
        if ((operand as unknown[]).some((entry) => same(value, entry))) return false;
        break;
      case "not":
        if (same(value, operand)) return false;
        break;
      case "lt":
        if (value === null || value === undefined || compare(value, operand) >= 0) return false;
        break;
      case "lte":
        if (value === null || value === undefined || compare(value, operand) > 0) return false;
        break;
      case "gt":
        if (value === null || value === undefined || compare(value, operand) <= 0) return false;
        break;
      case "gte":
        if (value === null || value === undefined || compare(value, operand) < 0) return false;
        break;
      default:
        throw new Error(`review memory: unsupported operator ${op}`);
    }
  }
  return true;
}

type Model = keyof ReviewTables;

export class ReviewMemory {
  readonly tables: ReviewTables = {
    workspace: [],
    user: [],
    membership: [],
    project: [],
    repurposeRun: [],
    clipCandidate: [],
    repurposeClip: [],
    clipVariant: [],
    export: [],
    clipReview: [],
    clipReviewEvent: [],
    clipComment: [],
    clipReviewLink: [],
    notification: [],
    clipGuestLink: [],
    mediaAsset: [],
    clipDub: [],
    clipDubVariant: [],
    llmOutput: [],
  };

  now: () => number = () => Date.now();

  /** Runs inside a transaction, before its first write: a test's "someone else got there first". */
  beforeTransaction: (() => void) | null = null;

  private matches(model: Model, row: Row, where: Row | undefined): boolean {
    if (where === undefined) return true;
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      if (key === "OR") {
        if (!(condition as Row[]).some((branch) => this.matches(model, row, branch))) return false;
        continue;
      }
      if (key === "AND") {
        if (!(condition as Row[]).every((branch) => this.matches(model, row, branch))) return false;
        continue;
      }
      if (model === "repurposeClip" && key === "run") {
        const run = this.tables.repurposeRun.find((entry) => entry["id"] === row["runId"]);
        if (run === undefined || !this.matches("repurposeRun", run, condition as Row)) return false;
        continue;
      }
      if (model === "user" && key === "memberships") {
        const some = (condition as Row)["some"] as Row;
        const found = this.tables.membership.some(
          (entry) => entry["userId"] === row["id"] && this.matches("membership", entry, some),
        );
        if (!found) return false;
        continue;
      }
      if (!fieldMatches(row[key], condition)) return false;
    }
    return true;
  }

  private sort(rows: Row[], orderBy: unknown): Row[] {
    const orders = Array.isArray(orderBy) ? orderBy : orderBy === undefined ? [] : [orderBy];
    return [...rows].sort((a, b) => {
      for (const order of orders as Record<string, "asc" | "desc">[]) {
        for (const [key, direction] of Object.entries(order)) {
          const av = a[key];
          const bv = b[key];
          if (same(av, bv)) continue;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          const result = typeof av === "string" ? av.localeCompare(String(bv)) : compare(av, bv);
          return direction === "desc" ? -result : result;
        }
      }
      return 0;
    });
  }

  /** The relations a query selected, attached to a copy of the row. */
  private shape(model: Model, row: Row, select: Row | undefined): Row {
    const out: Row = { ...row };
    if (select === undefined) return out;
    if (model === "repurposeClip" && select["candidate"] !== undefined) {
      out["candidate"] =
        this.tables.clipCandidate.find((entry) => entry["id"] === row["candidateId"]) ?? null;
    }
    if (model === "repurposeRun" && select["sourceProject"] !== undefined) {
      out["sourceProject"] =
        this.tables.project.find((entry) => entry["id"] === row["sourceProjectId"]) ?? null;
    }
    if (model === "workspace" && select["owner"] !== undefined) {
      out["owner"] = this.tables.user.find((entry) => entry["id"] === row["ownerId"]) ?? null;
    }
    if (model === "clipVariant") {
      if (select["latestExport"] !== undefined) {
        out["latestExport"] =
          this.tables.export.find((entry) => entry["id"] === row["latestExportId"]) ?? null;
      }
      const project = select["project"] as Row | undefined;
      const exportsQuery = (project?.["select"] as Row | undefined)?.["exports"] as Row | undefined;
      if (exportsQuery !== undefined) {
        const exports = this.sort(
          this.tables.export.filter(
            (entry) =>
              entry["projectId"] === row["projectId"] &&
              this.matches("export", entry, exportsQuery["where"] as Row | undefined),
          ),
          exportsQuery["orderBy"],
        );
        out["project"] = {
          exports: exports.slice(0, (exportsQuery["take"] as number | undefined) ?? exports.length),
        };
      }
    }
    return out;
  }

  private defaults(model: Model, data: Row): Row {
    const at = new Date(this.now());
    switch (model) {
      case "clipReview":
        return { version: 1, videos: {}, createdAt: at, updatedAt: at, decidedAt: at, ...data };
      case "clipReviewEvent":
        return { note: null, reason: null, videos: {}, createdAt: at, ...data };
      case "clipComment":
        return {
          atMs: null,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: at,
          updatedAt: at,
          ...data,
        };
      case "clipReviewLink":
        return {
          label: null,
          requireName: false,
          revokedAt: null,
          revokedBy: null,
          viewCount: 0,
          lastViewedAt: null,
          createdAt: at,
          ...data,
        };
      case "notification":
        return { readAt: null, createdAt: at, ...data };
      case "clipGuestLink":
        return {
          guestName: null,
          allClips: false,
          clipIds: [],
          includeDubs: false,
          revokedAt: null,
          revokedBy: null,
          viewCount: 0,
          lastViewedAt: null,
          downloadCount: 0,
          lastDownloadedAt: null,
          createdAt: at,
          ...data,
        };
      default:
        return { ...data };
    }
  }

  private apply(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isOperatorObject(value) && "increment" in value) {
        row[key] = (row[key] as number) + (value["increment"] as number);
      } else {
        row[key] = value;
      }
    }
  }

  private model(name: Model) {
    const rows = (): Row[] => this.tables[name];
    return {
      findUnique: async (args: {
        where: Row;
        select?: Row;
        include?: Row;
      }): Promise<Row | null> => {
        const row = rows().find((entry) => this.matches(name, entry, args.where));
        return row === undefined ? null : this.shape(name, row, args.select ?? args.include);
      },
      findFirst: async (args: {
        where?: Row;
        select?: Row;
        include?: Row;
        orderBy?: unknown;
      }): Promise<Row | null> => {
        const row = this.sort(
          rows().filter((entry) => this.matches(name, entry, args.where)),
          args.orderBy,
        )[0];
        return row === undefined ? null : this.shape(name, row, args.select ?? args.include);
      },
      findMany: async (
        args: {
          where?: Row;
          select?: Row;
          include?: Row;
          orderBy?: unknown;
          take?: number;
        } = {},
      ): Promise<Row[]> => {
        const found = this.sort(
          rows().filter((entry) => this.matches(name, entry, args.where)),
          args.orderBy,
        );
        return found
          .slice(0, args.take ?? found.length)
          .map((row) => this.shape(name, row, args.select ?? args.include));
      },
      count: async (args: { where?: Row } = {}): Promise<number> =>
        rows().filter((entry) => this.matches(name, entry, args.where)).length,
      groupBy: async (args: { by: string[]; where?: Row }): Promise<Row[]> => {
        const groups = new Map<string, Row>();
        for (const row of rows().filter((entry) => this.matches(name, entry, args.where))) {
          const key = JSON.stringify(args.by.map((field) => row[field]));
          const group = groups.get(key) ?? {
            ...Object.fromEntries(args.by.map((field) => [field, row[field]])),
            _count: { _all: 0 },
          };
          (group["_count"] as { _all: number })._all += 1;
          groups.set(key, group);
        }
        return [...groups.values()];
      },
      create: async (args: { data: Row }): Promise<Row> => {
        if (
          name === "clipReview" &&
          rows().some((entry) => entry["clipId"] === args.data["clipId"])
        ) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = this.defaults(name, args.data);
        rows().push(row);
        return { ...row };
      },
      update: async (args: { where: Row; data: Row }): Promise<Row> => {
        const row = rows().find((entry) => this.matches(name, entry, args.where));
        if (row === undefined) throw new Error(`review memory: no ${name} to update`);
        this.apply(row, args.data);
        return { ...row };
      },
      updateMany: async (args: { where: Row; data: Row }): Promise<{ count: number }> => {
        const found = rows().filter((entry) => this.matches(name, entry, args.where));
        for (const row of found) this.apply(row, args.data);
        return { count: found.length };
      },
    };
  }

  readonly workspace = this.model("workspace");
  readonly user = this.model("user");
  readonly repurposeRun = this.model("repurposeRun");
  readonly repurposeClip = this.model("repurposeClip");
  readonly clipVariant = this.model("clipVariant");
  readonly export = this.model("export");
  readonly clipReview = this.model("clipReview");
  readonly clipReviewEvent = this.model("clipReviewEvent");
  readonly clipComment = this.model("clipComment");
  readonly clipReviewLink = this.model("clipReviewLink");
  readonly notification = this.model("notification");
  readonly clipGuestLink = this.model("clipGuestLink");
  readonly mediaAsset = this.model("mediaAsset");
  readonly clipDub = this.model("clipDub");
  readonly clipDubVariant = this.model("clipDubVariant");
  readonly llmOutput = this.model("llmOutput");

  /**
   * A transaction over copies of every table: a throw discards what it wrote,
   * as a real one rolls back.
   */
  async $transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
    // The other writer commits first: its write survives this one rolling back.
    const interfere = this.beforeTransaction;
    this.beforeTransaction = null;
    interfere?.();
    const saved = Object.fromEntries(
      Object.entries(this.tables).map(([key, list]) => [
        key,
        (list as Row[]).map((row) => ({ ...row })),
      ]),
    ) as unknown as ReviewTables;
    try {
      return await work(this);
    } catch (error) {
      Object.assign(this.tables, saved);
      throw error;
    }
  }

  get prisma(): PrismaService {
    return this as unknown as PrismaService;
  }
}

// ---------------------------------------------------------------------------
// A workspace with one run and its clips
// ---------------------------------------------------------------------------

export const IDS = {
  ws: "01JWS00000000000000000000A",
  otherWs: "01JWS00000000000000000000B",
  owner: "01JUSER0000000000000000OWN",
  admin: "01JUSER0000000000000000ADM",
  editor: "01JUSER0000000000000000EDT",
  viewer: "01JUSER0000000000000000VWR",
  run: "01JRUN000000000000000000RA",
  otherRun: "01JRUN000000000000000000RB",
  source: "01JPRJ000000000000000SOURC",
} as const;

export type Shape = "9:16" | "4:5" | "1:1" | "16:9";

const ASPECT: Readonly<Record<Shape, string>> = {
  "9:16": "r9x16",
  "4:5": "r4x5",
  "1:1": "r1x1",
  "16:9": "r16x9",
};

/** The workspace, its people, and a run started by the editor. */
export function seedWorkspace(db: ReviewMemory, options: { settings?: Row } = {}): void {
  db.tables.workspace.push({
    id: IDS.ws,
    ownerId: IDS.owner,
    deletedAt: null,
    settings: options.settings ?? {},
  });
  for (const [id, name, role] of [
    [IDS.owner, "Owner Olga", "owner"],
    [IDS.admin, "Admin Asha", "admin"],
    [IDS.editor, "Editor Ravi", "editor"],
    [IDS.viewer, null, "viewer"],
  ] as const) {
    db.tables.user.push({
      id,
      name,
      email: `${role}@example.test`,
      locale: role === "admin" ? "hi-IN" : "en-IN",
      deletedAt: null,
    });
    db.tables.membership.push({ userId: id, workspaceId: IDS.ws, status: "active", role });
  }
  db.tables.project.push({ id: IDS.source, title: "Diwali vlog (upload)" });
  db.tables.repurposeRun.push({
    id: IDS.run,
    workspaceId: IDS.ws,
    createdBy: IDS.editor,
    sourceTitle: "Diwali vlog",
    sourceProjectId: IDS.source,
  });
}

/** One clip with a variant per shape; each shape in `rendered` has a finished render. */
export function seedClip(
  db: ReviewMemory,
  n: number,
  options: {
    readonly rendered?: readonly Shape[];
    readonly removed?: boolean;
    readonly runId?: string;
    readonly copy?: Row;
    readonly startMs?: number;
  } = {},
): string {
  const clipId = `01JCLIP00000000000000000C${String(n)}`;
  const candidateId = `01JCAND00000000000000000C${String(n)}`;
  db.tables.clipCandidate.push({
    id: candidateId,
    state: options.removed === true ? "rejected" : "materialized",
    startMs: options.startMs ?? n * 60_000,
  });
  db.tables.repurposeClip.push({
    id: clipId,
    runId: options.runId ?? IDS.run,
    candidateId,
    title: `Clip ${String(n)}`,
    copy: options.copy ?? {},
    mezzanineDurationMs: 30_000,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)),
  });
  for (const shape of options.rendered ?? ["9:16"]) renderClip(db, clipId, shape);
  return clipId;
}

let renders = 0;

/** A (new) finished captioned video for one shape of a clip, as Autopilot makes it. */
export function renderClip(db: ReviewMemory, clipId: string, shape: Shape): string {
  renders += 1;
  const code = ASPECT[shape];
  const variantId = `VAR-${clipId}-${code}`;
  const projectId = `PRJ-${clipId}-${code}`;
  const exportId = `EXP${String(renders).padStart(4, "0")}-${code}`;
  db.tables.export.push({
    id: exportId,
    workspaceId: IDS.ws,
    projectId,
    status: "succeeded",
    kind: "mp4",
    storageKey: `ws/${IDS.ws}/p/${projectId}/exports/${exportId}.mp4`,
    durationMs: 30_000,
    createdAt: new Date(Date.UTC(2026, 9, 1, 1, 0, renders)),
  });
  const variant = db.tables.clipVariant.find((row) => row["id"] === variantId);
  if (variant === undefined) {
    db.tables.clipVariant.push({
      id: variantId,
      clipId,
      projectId,
      aspect: code,
      latestExportId: exportId,
    });
  } else {
    variant["latestExportId"] = exportId;
  }
  return exportId;
}

/** What audit and notify were asked to do. */
export interface Recorders {
  readonly audits: CommonAuditEvent[];
  readonly notices: NotifyEnqueueInput[];
  readonly audit: CommonAuditService;
  readonly notify: {
    enqueue: (input: NotifyEnqueueInput) => Promise<{ idempotencyKey: string; enqueued: boolean }>;
  };
}

export function recorders(db: ReviewMemory): Recorders {
  const audits: CommonAuditEvent[] = [];
  const notices: NotifyEnqueueInput[] = [];
  return {
    audits,
    notices,
    audit: {
      record: async (event: CommonAuditEvent) => {
        audits.push(event);
      },
    } as unknown as CommonAuditService,
    notify: {
      enqueue: async (input: NotifyEnqueueInput) => {
        notices.push(input);
        // The bell row the real service writes, which the comment grouping reads.
        db.tables.notification.push({
          id: `N${String(notices.length)}`,
          userId: input.userId,
          kind: input.kind,
          data: input.data ?? {},
          createdAt: new Date(db.now()),
        });
        return { idempotencyKey: input.idempotencyKey ?? "", enqueued: true };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The review module wired over the memory database
// ---------------------------------------------------------------------------

export interface ReviewHarness extends Recorders {
  readonly db: ReviewMemory;
  readonly reviews: ClipReviewService;
  readonly clients: ClientReviewService;
  readonly notifier: ReviewNotifier;
  readonly gate: ClipApprovalGate;
  /** Presigned URLs handed out, by key. */
  readonly signed: string[];
  /** Tokens left in the per-link bucket; set to 0 to see a refusal. */
  linkBucket: number;
  setNow(at: number): void;
}

export function reviewHarness(
  options: {
    readonly flags?: Record<string, boolean>;
    readonly publicShares?: boolean;
    readonly settings?: Row;
    readonly now?: number;
  } = {},
): ReviewHarness {
  let now = options.now ?? Date.parse("2026-10-03T06:00:00Z");
  const db = new ReviewMemory();
  db.now = () => now;
  seedWorkspace(db, options.settings === undefined ? {} : { settings: options.settings });
  const rec = recorders(db);
  const flags = { repurpose_flow: true, ...options.flags };
  const entitlements = {
    forWorkspace: async () => ({ entitlements: { flags } }),
  } as unknown as EntitlementService;
  const env = {
    FEATURE_FLAGS_JSON: { "shares.public": options.publicShares ?? true },
    WEB_ORIGIN: "https://aksharo.test",
  } as unknown as Env;
  const signed: string[] = [];
  const derived = {
    presignGet: async (key: string, ttl: number, opts?: { downloadFilename?: string }) => {
      signed.push(key);
      return `https://media.test/${key}?X-Amz-Expires=${String(ttl)}${opts?.downloadFilename === undefined ? "" : "&download=1"}`;
    },
  } as unknown as ObjectStore;
  const notifier = new ReviewNotifier(db.prisma, rec.notify as unknown as NotifyService, env);
  notifier.now = () => now;
  const gate = new ClipApprovalGate(db.prisma);
  const reviews = new ClipReviewService(
    db.prisma,
    rec.audit,
    notifier,
    gate,
    entitlements,
    env,
    derived,
  );
  reviews.now = () => now;
  const harness: ReviewHarness = {
    ...rec,
    db,
    reviews,
    notifier,
    gate,
    signed,
    linkBucket: 1_000,
    clients: undefined as unknown as ClientReviewService,
    setNow(at: number) {
      now = at;
    },
  };
  const limiter = {
    consume: async () => {
      harness.linkBucket -= 1;
      return harness.linkBucket >= 0
        ? { allowed: true, remaining: harness.linkBucket, retryAfterSec: 0 }
        : { allowed: false, remaining: 0, retryAfterSec: 60 };
    },
  } as unknown as RateLimitService;
  const clients = new ClientReviewService(db.prisma, reviews, limiter, derived);
  clients.now = () => now;
  (harness as { clients: ClientReviewService }).clients = clients;
  return harness;
}
