/* eslint-disable security/detect-object-injection -- a test fake indexing its own rows by field name */
/**
 * An in-memory stand-in for the slice of Prisma the publishing module uses,
 * for its unit tests (no database, no Docker).
 *
 * It understands exactly the query shapes the module sends - equality, `in`,
 * `notIn`, `not`, `lt`/`lte`/`gt`/`gte`, `OR`, and the two relation filters
 * (`clip: { runId }`, `run: { workspaceId }`) - and enforces the one database
 * rule the module leans on: one LIVE post per (workspace, idempotency key)
 * (`publish_targets_live_idempotency_idx`, prisma/sql/0008). Included relations
 * come back whole; nothing here trims them to a `select`.
 *
 * Not a test file (no `.test.ts`), so it has no tests of its own; it is only
 * ever imported by the publishing tests.
 */

export type Row = Record<string, unknown>;

export interface Tables {
  publishTarget: Row[];
  publishBatch: Row[];
  channelConnection: Row[];
  repurposeRun: Row[];
  repurposeClip: Row[];
  clipCandidate: Row[];
  clipVariant: Row[];
  export: Row[];
  edgDocument: Row[];
}

const DEAD = new Set(["cancelled", "failed_permanent"]);

function compare(value: unknown, other: unknown): number {
  const a = value instanceof Date ? value.getTime() : (value as number);
  const b = other instanceof Date ? other.getTime() : (other as number);
  return a < b ? -1 : a > b ? 1 : 0;
}

function same(value: unknown, other: unknown): boolean {
  if (value instanceof Date && other instanceof Date) return value.getTime() === other.getTime();
  return value === other;
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (
    condition === null ||
    typeof condition !== "object" ||
    condition instanceof Date ||
    Array.isArray(condition)
  ) {
    return same(value, condition);
  }
  const ops = condition as Record<string, unknown>;
  for (const [op, operand] of Object.entries(ops)) {
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
        throw new Error(`memory prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

export class MemoryPrisma {
  readonly tables: Tables = {
    publishTarget: [],
    publishBatch: [],
    channelConnection: [],
    repurposeRun: [],
    repurposeClip: [],
    clipCandidate: [],
    clipVariant: [],
    export: [],
    edgDocument: [],
  };

  now: () => number = () => Date.now();

  private matches(model: keyof Tables, row: Row, where: Row | undefined): boolean {
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
      if (model === "publishTarget" && key === "clip") {
        const clip = this.tables.repurposeClip.find((entry) => entry["id"] === row["clipId"]);
        if (clip === undefined || !this.matches("repurposeClip", clip, condition as Row))
          return false;
        continue;
      }
      if (model === "repurposeClip" && key === "run") {
        const run = this.tables.repurposeRun.find((entry) => entry["id"] === row["runId"]);
        if (run === undefined || !this.matches("repurposeRun", run, condition as Row)) return false;
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
          const result = compare(av, bv);
          return direction === "desc" ? -result : result;
        }
      }
      return 0;
    });
  }

  private targetWith(row: Row): Row {
    const clip = this.tables.repurposeClip.find((entry) => entry["id"] === row["clipId"]);
    return {
      ...row,
      channelConnection:
        this.tables.channelConnection.find((entry) => entry["id"] === row["channelConnectionId"]) ??
        null,
      export: this.tables.export.find((entry) => entry["id"] === row["exportId"]) ?? null,
      clip: clip ?? null,
      variant: this.tables.clipVariant.find((entry) => entry["id"] === row["variantId"]) ?? null,
    };
  }

  private clipWith(row: Row): Row {
    return {
      ...row,
      run: this.tables.repurposeRun.find((entry) => entry["id"] === row["runId"]) ?? null,
      candidate:
        this.tables.clipCandidate.find((entry) => entry["id"] === row["candidateId"]) ?? null,
    };
  }

  private touch(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) row[key] = value;
    }
    if (!("updatedAt" in data)) row["updatedAt"] = new Date(this.now());
  }

  readonly publishTarget = {
    findUnique: async (args: { where: Row }): Promise<Row | null> => {
      const row = this.tables.publishTarget.find((entry) => entry["id"] === args.where["id"]);
      return row === undefined ? null : this.targetWith(row);
    },
    findFirst: async (args: { where: Row }): Promise<Row | null> => {
      const row = this.tables.publishTarget.find((entry) =>
        this.matches("publishTarget", entry, args.where),
      );
      return row === undefined ? null : this.targetWith(row);
    },
    findMany: async (args: { where?: Row; orderBy?: unknown; take?: number }): Promise<Row[]> => {
      const rows = this.sort(
        this.tables.publishTarget.filter((entry) =>
          this.matches("publishTarget", entry, args.where),
        ),
        args.orderBy,
      );
      return rows.slice(0, args.take ?? rows.length).map((row) => this.targetWith(row));
    },
    create: async (args: { data: Row }): Promise<Row> => {
      const data = args.data;
      if (
        !DEAD.has(String(data["status"])) &&
        this.tables.publishTarget.some(
          (entry) =>
            entry["workspaceId"] === data["workspaceId"] &&
            entry["idempotencyKey"] === data["idempotencyKey"] &&
            !DEAD.has(String(entry["status"])),
        )
      ) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const at = new Date(this.now());
      const row: Row = {
        externalPostId: null,
        externalUrl: null,
        externalStatus: null,
        externalMediaId: null,
        externalMediaPath: null,
        lastErrorCode: null,
        lastErrorSafeMessage: null,
        retryAfter: null,
        submittedAt: null,
        publishedAt: null,
        nextCheckAt: null,
        checkNo: 0,
        scheduledAt: null,
        createdAt: at,
        updatedAt: at,
        ...data,
      };
      this.tables.publishTarget.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.tables.publishTarget.find((entry) => entry["id"] === args.where["id"]);
      if (row === undefined) throw new Error("memory prisma: no such publish target");
      this.touch(row, args.data);
      return row;
    },
    updateMany: async (args: { where: Row; data: Row }): Promise<{ count: number }> => {
      const rows = this.tables.publishTarget.filter((entry) =>
        this.matches("publishTarget", entry, args.where),
      );
      for (const row of rows) this.touch(row, args.data);
      return { count: rows.length };
    },
  };

  readonly publishBatch = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row = { ...args.data };
      this.tables.publishBatch.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.tables.publishBatch.find((entry) => entry["id"] === args.where["id"]);
      if (row === undefined) throw new Error("memory prisma: no such batch");
      Object.assign(row, args.data);
      return row;
    },
  };

  readonly channelConnection = {
    findMany: async (args: { where?: Row }): Promise<Row[]> =>
      this.tables.channelConnection.filter((entry) =>
        this.matches("channelConnection", entry, args.where),
      ),
    findFirst: async (args: { where?: Row }): Promise<Row | null> =>
      this.tables.channelConnection.find((entry) =>
        this.matches("channelConnection", entry, args.where),
      ) ?? null,
    create: async (args: { data: Row }): Promise<Row> => {
      const data = args.data;
      if (
        this.tables.channelConnection.some(
          (entry) =>
            entry["workspaceId"] === data["workspaceId"] &&
            entry["externalIntegrationId"] === data["externalIntegrationId"],
        )
      ) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row: Row = { username: null, avatarUrl: null, displayName: null, ...data };
      this.tables.channelConnection.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.tables.channelConnection.find((entry) => entry["id"] === args.where["id"]);
      if (row === undefined) throw new Error("memory prisma: no such connection");
      Object.assign(row, args.data);
      return row;
    },
    updateMany: async (args: { where: Row; data: Row }): Promise<{ count: number }> => {
      const rows = this.tables.channelConnection.filter((entry) =>
        this.matches("channelConnection", entry, args.where),
      );
      for (const row of rows) Object.assign(row, args.data);
      return { count: rows.length };
    },
  };

  readonly repurposeRun = {
    findFirst: async (args: { where?: Row }): Promise<Row | null> =>
      this.tables.repurposeRun.find((entry) => this.matches("repurposeRun", entry, args.where)) ??
      null,
  };

  readonly repurposeClip = {
    findFirst: async (args: { where?: Row }): Promise<Row | null> => {
      const row = this.tables.repurposeClip.find((entry) =>
        this.matches("repurposeClip", entry, args.where),
      );
      return row === undefined ? null : this.clipWith(row);
    },
    findMany: async (args: { where?: Row }): Promise<Row[]> =>
      this.tables.repurposeClip
        .filter((entry) => this.matches("repurposeClip", entry, args.where))
        .map((row) => this.clipWith(row)),
  };

  /** Just `clipVideos`' query: a clip's variants, their render and their project's newest MP4. */
  readonly clipVariant = {
    findMany: async (args: { where: Row }): Promise<Row[]> =>
      this.tables.clipVariant
        .filter((entry) => entry["clipId"] === args.where["clipId"])
        .map((variant) => {
          const exports = this.sort(
            this.tables.export.filter(
              (row) =>
                row["projectId"] === variant["projectId"] &&
                row["status"] === "succeeded" &&
                row["kind"] === "mp4" &&
                row["storageKey"] !== null,
            ),
            { createdAt: "desc" },
          ).slice(0, 1);
          const doc = this.tables.edgDocument.find(
            (row) => row["projectId"] === variant["projectId"],
          );
          return {
            ...variant,
            latestExport:
              this.tables.export.find((row) => row["id"] === variant["latestExportId"]) ?? null,
            project: {
              edgDocument: doc === undefined ? null : { updatedAt: doc["updatedAt"] },
              exports,
            },
          };
        }),
  };

  async $transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
    return work(this);
  }
}

// ---------------------------------------------------------------------------
// A run with one clip, for the publishing tests
// ---------------------------------------------------------------------------

export const IDS = {
  ws: "01JCWS0000000000000000000A",
  otherWs: "01JCWS0000000000000000000B",
  user: "01JCVSER000000000000000000",
  run: "01JCRN0000000000000000000A",
  candidate: "01JCCANDA00000000000000000",
  clip: "01JCC11PA00000000000000000",
} as const;

type Shape = "9:16" | "4:5" | "1:1" | "16:9";

const SHAPE_CODE: Readonly<Record<Shape, { aspect: string; code: string }>> = {
  "9:16": { aspect: "r9x16", code: "916" },
  "4:5": { aspect: "r4x5", code: "450" },
  "1:1": { aspect: "r1x1", code: "110" },
  "16:9": { aspect: "r16x9", code: "169" },
};

export interface SeedOptions {
  /** Shapes with a finished captioned video (Autopilot's render, current). Default: all four. */
  readonly ready?: readonly Shape[];
  /** Shapes whose captioned video is still being made. */
  readonly making?: readonly Shape[];
  readonly copy?: unknown;
  readonly sourceFingerprint?: string | null;
  readonly durationMs?: number;
  readonly clipId?: string;
  readonly candidateId?: string;
  readonly title?: string;
  readonly removed?: boolean;
}

/** Seeds the run (once), and one clip with a variant and a render per shape. */
export function seedClip(db: MemoryPrisma, options: SeedOptions = {}): { clipId: string } {
  const clipId = options.clipId ?? IDS.clip;
  const candidateId = options.candidateId ?? IDS.candidate;
  const suffix = clipId.slice(-4);
  if (!db.tables.repurposeRun.some((run) => run["id"] === IDS.run)) {
    db.tables.repurposeRun.push({
      id: IDS.run,
      workspaceId: IDS.ws,
      sourceFingerprint:
        options.sourceFingerprint === undefined ? "youtube:dQw4w9WgXcQ" : options.sourceFingerprint,
    });
  }
  db.tables.clipCandidate.push({
    id: candidateId,
    runId: IDS.run,
    state: options.removed === true ? "rejected" : "proposed",
  });
  db.tables.repurposeClip.push({
    id: clipId,
    runId: IDS.run,
    candidateId,
    title: options.title ?? "Why most people never save",
    copy: options.copy ?? {},
    sourceStartMs: 60_000,
    sourceEndMs: 90_000,
    mezzanineDurationMs: options.durationMs ?? 31_000,
  });
  const ready = options.ready ?? ["9:16", "4:5", "1:1", "16:9"];
  for (const shape of [...ready, ...(options.making ?? [])]) {
    const { aspect, code } = SHAPE_CODE[shape];
    const variantId = `01JCVAR${code}${suffix}00000000000000`.slice(0, 26);
    const projectId = `01JCPRJ${code}${suffix}00000000000000`.slice(0, 26);
    const exportId = `01JCEXP${code}${suffix}00000000000000`.slice(0, 26);
    const isReady = ready.includes(shape);
    db.tables.export.push({
      id: exportId,
      projectId,
      status: isReady ? "succeeded" : "rendering",
      kind: "mp4",
      storageKey: isReady ? `ws/${projectId}/exports/${exportId}.mp4` : null,
      bucket: "r2",
      sizeBytes: isReady ? BigInt(24) : null,
      durationMs: options.durationMs ?? 31_000,
      createdAt: new Date("2026-09-30T10:00:00Z"),
    });
    db.tables.clipVariant.push({
      id: variantId,
      clipId,
      projectId,
      aspect,
      status: isReady ? "ready" : "rendering",
      latestExportId: exportId,
    });
  }
  return { clipId };
}
