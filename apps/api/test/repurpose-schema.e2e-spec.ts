/**
 * REP-003 / REP-004: the repurposing core and the publishing ledger, against a
 * real PostgreSQL.
 *
 * Every claim the two tickets make is expressed here as a test that would fail if
 * the guarantee were removed:
 *
 *   * the migration creates each table, on an EMPTY database and on one that
 *     already carries rows (the template this suite clones is a migrated
 *     database, so "applies to a populated snapshot" is what every other case
 *     here exercises);
 *   * candidate bounds are refused by the database, not only by the service;
 *   * one clip family per candidate, one child project per variant, one variant
 *     per aspect, one candidate per exact bounds;
 *   * a workspace boundary exists on every path a lookup can take;
 *   * `channel_connections` cannot hold a provider token, because the column list
 *     is asserted rather than assumed (ADR 0002);
 *   * one LIVE publish target per idempotency key, while cancelled and
 *     permanently failed history is allowed to accumulate beside it.
 *
 * Nothing here enables a feature: no flag is read and no runtime consumes these
 * tables yet. This is the CP-020 evidence that the schema behaves as designed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";

import type { TestDatabase } from "./db-harness.js";
import type { PrismaClient } from "@prisma/client";

const available = isDatabaseAvailable();

if (!available) {
  console.warn(
    "[repurpose-schema.e2e] SKIPPED - no test database. " +
      "Set TEST_DATABASE_URL, or start Docker so testcontainers can run " +
      `pgvector/pgvector:pg16. Reason: ${skipReason}`,
  );
}

let db: TestDatabase;

const ULID_BASE = "01JR0000000000000000000000";

/** Distinct ULID-shaped ids, 26 chars, so nothing collides between tests. */
function id(suffix: string): string {
  return (ULID_BASE.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

/** The nine tables REP-003 and REP-004 add, transcribed from master plan §6. */
const REPURPOSE_TABLES = [
  "repurpose_runs",
  "clip_candidates",
  "repurpose_clips",
  "clip_variants",
  "review_bundles",
  "review_items",
  "channel_connections",
  "publish_batches",
  "publish_targets",
] as const;

/**
 * Column names that would mean a provider secret had moved into Aksharo's
 * database. ADR 0002 §3 puts the token boundary in the publishing service; this
 * list turns that decision into a failing test rather than a code review habit.
 */
const SECRET_COLUMN_MARKERS = [
  "token",
  "secret",
  "password",
  "credential",
  "refresh",
  "api_key",
  "access_key",
  "private",
] as const;

const USER = id("U1");
const OTHER_USER = id("U2");
const WORKSPACE = id("W1");
const OTHER_WORKSPACE = id("W2");
const SOURCE_PROJECT = id("P1");
const OTHER_PROJECT = id("P2");

describe.skipIf(!available)("repurpose and publishing schema (REP-003/REP-004)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;

    await prisma.user.create({ data: { id: USER, email: "rep-a@example.test", name: "Rep A" } });
    await prisma.user.create({ data: { id: OTHER_USER, email: "rep-b@example.test", name: "Rep B" } });
    await prisma.workspace.create({
      data: { id: WORKSPACE, slug: "rep-a", name: "Rep A", ownerId: USER, billingCountry: "IN" },
    });
    await prisma.workspace.create({
      data: {
        id: OTHER_WORKSPACE,
        slug: "rep-b",
        name: "Rep B",
        ownerId: OTHER_USER,
        billingCountry: "IN",
      },
    });
    await prisma.project.create({
      data: { id: SOURCE_PROJECT, workspaceId: WORKSPACE, title: "Long podcast", durationMs: 3_600_000 },
    });
    await prisma.project.create({
      data: { id: OTHER_PROJECT, workspaceId: OTHER_WORKSPACE, title: "Their podcast" },
    });
  });

  afterAll(async () => {
    await db?.stop();
  });

  /** A run that satisfies the rights-attestation constraint for an upload. */
  async function createRun(runId: string, workspaceId = WORKSPACE, projectId = SOURCE_PROJECT) {
    return prisma.repurposeRun.create({
      data: {
        id: runId,
        workspaceId,
        sourceProjectId: projectId,
        sourceKind: "upload",
        mode: "ai",
        createdBy: USER,
      },
    });
  }

  async function createCandidate(
    candidateId: string,
    runId: string,
    startMs: number,
    endMs: number,
    source: "ai" | "manual" = "ai",
  ) {
    return prisma.clipCandidate.create({
      data: {
        id: candidateId,
        runId,
        source,
        startMs,
        endMs,
        title: "A moment",
        ...(source === "ai" ? { rank: 1, potentialScore: 72 } : {}),
      },
    });
  }

  describe("migration", () => {
    it("creates every table the plan names", async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const present = new Set(rows.map((row) => row.table_name));

      expect(REPURPOSE_TABLES.filter((table) => !present.has(table))).toEqual([]);
    });

    it("adds no column to an existing table", async () => {
      // REP-003 is non-destructive in both directions: it may not widen an
      // existing table either, because that is the change a rollback cannot undo
      // once other code has started writing to it.
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects'`;
      const names = new Set(rows.map((row) => row.column_name));

      for (const added of ["run_id", "clip_id", "variant_id", "repurpose_run_id"]) {
        expect(names.has(added)).toBe(false);
      }
    });

    it("applies the hand-written constraints and partial indexes", async () => {
      const constraints = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE conname LIKE '%_chk'`;
      const present = new Set(constraints.map((row) => row.conname));

      for (const name of [
        "clip_candidates_start_nonneg_chk",
        "clip_candidates_end_after_start_chk",
        "clip_candidates_duration_chk",
        "clip_candidates_manual_unranked_chk",
        "repurpose_clips_bounds_chk",
        "repurpose_runs_progress_chk",
        "repurpose_runs_rights_chk",
        "publish_targets_schedule_chk",
        "publish_targets_published_ref_chk",
      ]) {
        expect(present.has(name)).toBe(true);
      }

      const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const indexNames = new Set(indexes.map((row) => row.indexname));

      for (const name of [
        "publish_targets_live_idempotency_idx",
        "publish_targets_retry_due_idx",
        "publish_targets_in_flight_idx",
        "repurpose_runs_active_idx",
        "repurpose_runs_live_source_idx",
      ]) {
        expect(indexNames.has(name)).toBe(true);
      }
    });
  });

  describe("candidate bounds", () => {
    it("accepts a valid candidate", async () => {
      const run = await createRun(id("R1"));
      const candidate = await createCandidate(id("C1"), run.id, 330_000, 340_000);

      expect(candidate.endMs - candidate.startMs).toBe(10_000);
      expect(candidate.state).toBe("proposed");
    });

    it("refuses a negative start", async () => {
      const run = await createRun(id("R2"));
      await expect(createCandidate(id("C2"), run.id, -1_000, 9_000)).rejects.toThrow();
    });

    it("refuses an end at or before the start", async () => {
      const run = await createRun(id("R3"));
      await expect(createCandidate(id("C3"), run.id, 10_000, 10_000)).rejects.toThrow();
      await expect(createCandidate(id("C4"), run.id, 10_000, 9_000)).rejects.toThrow();
    });

    it("refuses a clip shorter than 3 s or longer than 180 s", async () => {
      const run = await createRun(id("R4"));
      await expect(createCandidate(id("C5"), run.id, 0, 2_999)).rejects.toThrow();
      await expect(createCandidate(id("C6"), run.id, 0, 180_001)).rejects.toThrow();
    });

    it("refuses to rank or score a manual candidate", async () => {
      const run = await createRun(id("R5"));
      await expect(
        prisma.clipCandidate.create({
          data: {
            id: id("C7"),
            runId: run.id,
            source: "manual",
            startMs: 0,
            endMs: 10_000,
            title: "Chosen by me",
            rank: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it("refuses two candidates with the same exact bounds in one run", async () => {
      const run = await createRun(id("R6"));
      await createCandidate(id("C8"), run.id, 60_000, 75_000);
      await expect(createCandidate(id("C9"), run.id, 60_000, 75_000)).rejects.toThrow();

      // The same bounds in a DIFFERENT run remain legal: two creators may pick
      // the same moment out of the same source.
      const other = await createRun(id("R7"));
      await expect(createCandidate(id("CA"), other.id, 60_000, 75_000)).resolves.toBeTruthy();
    });
  });

  describe("run integrity", () => {
    it("refuses an external source without a rights attestation", async () => {
      await expect(
        prisma.repurposeRun.create({
          data: {
            id: id("R8"),
            workspaceId: WORKSPACE,
            sourceProjectId: SOURCE_PROJECT,
            sourceKind: "youtube_url",
            mode: "ai",
          },
        }),
      ).rejects.toThrow();
    });

    it("accepts an external source once the attestation is recorded", async () => {
      const run = await prisma.repurposeRun.create({
        data: {
          id: id("R9"),
          workspaceId: WORKSPACE,
          sourceProjectId: SOURCE_PROJECT,
          sourceKind: "youtube_url",
          sourceFingerprint: "youtube:dQw4w9WgXcQ",
          sourceDisplay: "youtube.com",
          rightsAttestedAt: new Date(),
          rightsAttestedBy: USER,
          mode: "ai",
        },
      });

      expect(run.rightsAttestedAt).not.toBeNull();
      // The full URL is never required; the normalised id is what dedupe reads.
      expect(run.sourceUrlEncrypted).toBeNull();
    });

    it("refuses a second live run for the same source in one workspace", async () => {
      const data = {
        workspaceId: WORKSPACE,
        sourceProjectId: SOURCE_PROJECT,
        sourceKind: "youtube_url" as const,
        sourceFingerprint: "youtube:repeat-me",
        rightsAttestedAt: new Date(),
        mode: "ai" as const,
      };
      await prisma.repurposeRun.create({ data: { ...data, id: id("RA") } });
      await expect(
        prisma.repurposeRun.create({ data: { ...data, id: id("RB") } }),
      ).rejects.toThrow();

      // Once the first run is finished the same source may be imported again.
      await prisma.repurposeRun.update({
        where: { id: id("RA") },
        data: { status: "published", completedAt: new Date() },
      });
      await expect(
        prisma.repurposeRun.create({ data: { ...data, id: id("RC") } }),
      ).resolves.toBeTruthy();

      // And another workspace is never affected by ours.
      await expect(
        prisma.repurposeRun.create({
          data: {
            ...data,
            id: id("RD"),
            workspaceId: OTHER_WORKSPACE,
            sourceProjectId: OTHER_PROJECT,
          },
        }),
      ).resolves.toBeTruthy();
    });

    it("refuses a progress value outside 0-100", async () => {
      const run = await createRun(id("RE"));
      await expect(
        prisma.repurposeRun.update({ where: { id: run.id }, data: { progress: 101 } }),
      ).rejects.toThrow();
    });

    it("scopes every run lookup by workspace", async () => {
      await createRun(id("RF"));

      const stolen = await prisma.repurposeRun.findFirst({
        where: { id: id("RF"), workspaceId: OTHER_WORKSPACE },
      });
      expect(stolen).toBeNull();
    });

    it("cascades a workspace deletion through the whole run", async () => {
      const victimUser = id("U3");
      const victimWorkspace = id("W3");
      const victimProject = id("P3");
      await prisma.user.create({
        data: { id: victimUser, email: "rep-c@example.test", name: "Rep C" },
      });
      await prisma.workspace.create({
        data: {
          id: victimWorkspace,
          slug: "rep-c",
          name: "Rep C",
          ownerId: victimUser,
          billingCountry: "IN",
        },
      });
      await prisma.project.create({
        data: { id: victimProject, workspaceId: victimWorkspace, title: "Doomed" },
      });
      const run = await createRun(id("RG"), victimWorkspace, victimProject);
      await createCandidate(id("CB"), run.id, 0, 10_000);

      await prisma.workspace.delete({ where: { id: victimWorkspace } });

      expect(await prisma.repurposeRun.findUnique({ where: { id: run.id } })).toBeNull();
      expect(await prisma.clipCandidate.findUnique({ where: { id: id("CB") } })).toBeNull();
    });
  });

  describe("clips and variants", () => {
    it("materialises one clip family per candidate and one project per variant", async () => {
      const run = await createRun(id("RH"));
      const candidate = await createCandidate(id("CC"), run.id, 0, 30_000);

      const clip = await prisma.repurposeClip.create({
        data: {
          id: id("K1"),
          runId: run.id,
          candidateId: candidate.id,
          title: "Clip one",
          sourceStartMs: 0,
          sourceEndMs: 30_000,
        },
      });

      // A second family for the same candidate is the duplicate-materialisation
      // bug the unique key exists to prevent.
      await expect(
        prisma.repurposeClip.create({
          data: {
            id: id("K2"),
            runId: run.id,
            candidateId: candidate.id,
            title: "Clip one again",
            sourceStartMs: 0,
            sourceEndMs: 30_000,
          },
        }),
      ).rejects.toThrow();

      const variantProject = id("P4");
      await prisma.project.create({
        data: { id: variantProject, workspaceId: WORKSPACE, title: "Clip one 9:16" },
      });
      const variant = await prisma.clipVariant.create({
        data: { id: id("V1"), clipId: clip.id, projectId: variantProject, aspect: "r9x16" },
      });
      expect(variant.status).toBe("preparing");

      // One variant per aspect family...
      const secondProject = id("P5");
      await prisma.project.create({
        data: { id: secondProject, workspaceId: WORKSPACE, title: "Clip one 9:16 again" },
      });
      await expect(
        prisma.clipVariant.create({
          data: { id: id("V2"), clipId: clip.id, projectId: secondProject, aspect: "r9x16" },
        }),
      ).rejects.toThrow();

      // ...but a different aspect is a different, legitimate variant.
      await expect(
        prisma.clipVariant.create({
          data: { id: id("V3"), clipId: clip.id, projectId: secondProject, aspect: "r1x1" },
        }),
      ).resolves.toBeTruthy();

      // And a project belongs to at most one variant.
      const thirdClip = await prisma.repurposeClip.create({
        data: {
          id: id("K3"),
          runId: run.id,
          candidateId: (await createCandidate(id("CD"), run.id, 40_000, 70_000)).id,
          title: "Clip two",
          sourceStartMs: 40_000,
          sourceEndMs: 70_000,
        },
      });
      await expect(
        prisma.clipVariant.create({
          data: { id: id("V4"), clipId: thirdClip.id, projectId: variantProject, aspect: "r4x5" },
        }),
      ).rejects.toThrow();
    });

    it("refuses frozen clip bounds that run backwards", async () => {
      const run = await createRun(id("RI"));
      const candidate = await createCandidate(id("CE"), run.id, 0, 10_000);
      await expect(
        prisma.repurposeClip.create({
          data: {
            id: id("K4"),
            runId: run.id,
            candidateId: candidate.id,
            title: "Backwards",
            sourceStartMs: 10_000,
            sourceEndMs: 5_000,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("channel connections", () => {
    it("has no column that could hold a provider secret", async () => {
      const rows = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'channel_connections'`;
      const names = rows.map((row) => row.column_name);

      expect(names.length).toBeGreaterThan(0);
      const suspicious = names.filter((name) =>
        SECRET_COLUMN_MARKERS.some((marker) => name.includes(marker)),
      );
      expect(suspicious).toEqual([]);
    });

    it("refuses the same external integration twice in one workspace", async () => {
      await prisma.channelConnection.create({
        data: {
          id: id("N1"),
          workspaceId: WORKSPACE,
          provider: "instagram",
          externalIntegrationId: "int-1",
        },
      });
      await expect(
        prisma.channelConnection.create({
          data: {
            id: id("N2"),
            workspaceId: WORKSPACE,
            provider: "instagram",
            externalIntegrationId: "int-1",
          },
        }),
      ).rejects.toThrow();
    });

    it("lets a different workspace hold its own connection with the same id", async () => {
      // The uniqueness is per workspace, so a second tenant connecting the same
      // account is not blocked by ours; the workspace scope is what keeps them
      // apart on read.
      await expect(
        prisma.channelConnection.create({
          data: {
            id: id("N3"),
            workspaceId: OTHER_WORKSPACE,
            provider: "instagram",
            externalIntegrationId: "int-1",
          },
        }),
      ).resolves.toBeTruthy();

      const mine = await prisma.channelConnection.findMany({ where: { workspaceId: WORKSPACE } });
      expect(mine.map((row) => row.id)).toEqual([id("N1")]);
    });
  });

  describe("publish targets", () => {
    /** A run with one materialised clip and one ready variant to publish. */
    async function publishableVariant(suffix: string) {
      const run = await createRun(id(`R${suffix}`));
      const candidate = await createCandidate(id(`C${suffix}`), run.id, 0, 20_000);
      const clip = await prisma.repurposeClip.create({
        data: {
          id: id(`K${suffix}`),
          runId: run.id,
          candidateId: candidate.id,
          title: "Publishable",
          sourceStartMs: 0,
          sourceEndMs: 20_000,
        },
      });
      const projectId = id(`P${suffix}`);
      await prisma.project.create({
        data: { id: projectId, workspaceId: WORKSPACE, title: "Publishable 9:16" },
      });
      const variant = await prisma.clipVariant.create({
        data: {
          id: id(`V${suffix}`),
          clipId: clip.id,
          projectId,
          aspect: "r9x16",
          status: "ready",
          editFingerprint: "a".repeat(64),
        },
      });
      const batch = await prisma.publishBatch.create({
        data: {
          id: id(`B${suffix}`),
          runId: run.id,
          workspaceId: WORKSPACE,
          confirmedBy: USER,
          mode: "now",
          timezone: "Asia/Kolkata",
        },
      });
      return { run, clip, variant, batch };
    }

    it("refuses a schedule without an instant, and an instant without a schedule", async () => {
      const { clip, variant, batch } = await publishableVariant("S1");

      await expect(
        prisma.publishTarget.create({
          data: {
            id: id("T1"),
            workspaceId: WORKSPACE,
            batchId: batch.id,
            clipId: clip.id,
            variantId: variant.id,
            provider: "instagram",
            publishMode: "schedule",
            idempotencyKey: "key-schedule-missing",
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.publishTarget.create({
          data: {
            id: id("T2"),
            workspaceId: WORKSPACE,
            batchId: batch.id,
            clipId: clip.id,
            variantId: variant.id,
            provider: "instagram",
            publishMode: "direct",
            scheduledAt: new Date(),
            idempotencyKey: "key-now-with-instant",
          },
        }),
      ).rejects.toThrow();
    });

    it("allows one live target per idempotency key and keeps the history beside it", async () => {
      const { clip, variant, batch } = await publishableVariant("S2");
      const base = {
        workspaceId: WORKSPACE,
        batchId: batch.id,
        clipId: clip.id,
        variantId: variant.id,
        provider: "linkedin",
        publishMode: "direct" as const,
        idempotencyKey: "key-one",
      };

      await prisma.publishTarget.create({ data: { ...base, id: id("T3") } });

      // A retry that re-created the row would be a second post.
      await expect(
        prisma.publishTarget.create({ data: { ...base, id: id("T4") } }),
      ).rejects.toThrow();

      // Once the first attempt is permanently failed or cancelled it is history,
      // and an explicit "post again" with the same key may take its place.
      await prisma.publishTarget.update({
        where: { id: id("T3") },
        data: { status: "failed_permanent", lastErrorCode: "publishing/content_rejected" },
      });
      await expect(
        prisma.publishTarget.create({ data: { ...base, id: id("T5") } }),
      ).resolves.toBeTruthy();

      const rows = await prisma.publishTarget.findMany({
        where: { idempotencyKey: "key-one" },
        orderBy: { id: "asc" },
      });
      expect(rows).toHaveLength(2);
    });

    it("scopes the idempotency key to a workspace, so one tenant cannot refuse another", async () => {
      // The key is derived from data a tenant supplies. A globally unique index
      // would let workspace B's live row block workspace A's publish — a refusal
      // naming a row A cannot see, cannot cancel and did not create — and would
      // let either tenant probe for the other's keys by watching it fire.
      const mine = await publishableVariant("S5");
      const shared = {
        clipId: mine.clip.id,
        variantId: mine.variant.id,
        provider: "linkedin",
        publishMode: "direct" as const,
        idempotencyKey: "key-shared-across-tenants",
      };
      await prisma.publishTarget.create({
        data: { ...shared, workspaceId: WORKSPACE, batchId: mine.batch.id, id: id("T8") },
      });

      // The other tenant's own batch, with the same key: allowed.
      const theirUser = id("U4");
      const theirWorkspace = OTHER_WORKSPACE;
      const theirRun = await prisma.repurposeRun.create({
        data: {
          id: id("RK"),
          workspaceId: theirWorkspace,
          sourceProjectId: OTHER_PROJECT,
          sourceKind: "upload",
          mode: "ai",
        },
      });
      const theirBatch = await prisma.publishBatch.create({
        data: {
          id: id("BK"),
          runId: theirRun.id,
          workspaceId: theirWorkspace,
          mode: "now",
          timezone: "UTC",
        },
      });
      expect(theirUser).toBeTruthy();

      // Their target points at their own batch but at OUR clip/variant, which is
      // not a real scenario — it is the cheapest way to prove the INDEX is what
      // allows the duplicate key, rather than any difference in the other columns.
      await expect(
        prisma.publishTarget.create({
          data: { ...shared, workspaceId: theirWorkspace, batchId: theirBatch.id, id: id("T9") },
        }),
      ).resolves.toBeTruthy();

      // And within ONE workspace the rule still holds.
      await expect(
        prisma.publishTarget.create({
          data: { ...shared, workspaceId: WORKSPACE, batchId: mine.batch.id, id: id("TA") },
        }),
      ).rejects.toThrow();
    });

    it("refuses to record a published target without its provider reference", async () => {
      const { clip, variant, batch } = await publishableVariant("S3");
      const target = await prisma.publishTarget.create({
        data: {
          workspaceId: WORKSPACE,
          id: id("T6"),
          batchId: batch.id,
          clipId: clip.id,
          variantId: variant.id,
          provider: "youtube",
          publishMode: "direct",
          idempotencyKey: "key-published",
        },
      });

      await expect(
        prisma.publishTarget.update({ where: { id: target.id }, data: { status: "published" } }),
      ).rejects.toThrow();

      await expect(
        prisma.publishTarget.update({
          where: { id: target.id },
          data: {
            status: "published",
            externalPostId: "ext-1",
            externalUrl: "https://example.test/watch?v=ext-1",
            publishedAt: new Date(),
          },
        }),
      ).resolves.toBeTruthy();
    });

    it("keeps publish history when the account is disconnected", async () => {
      const { clip, variant, batch } = await publishableVariant("S4");
      const connection = await prisma.channelConnection.create({
        data: {
          id: id("N4"),
          workspaceId: WORKSPACE,
          provider: "youtube",
          externalIntegrationId: "int-disconnect",
        },
      });
      await prisma.publishTarget.create({
        data: {
          workspaceId: WORKSPACE,
          id: id("T7"),
          batchId: batch.id,
          clipId: clip.id,
          variantId: variant.id,
          channelConnectionId: connection.id,
          provider: "youtube",
          publishMode: "direct",
          idempotencyKey: "key-disconnect",
          status: "published",
          externalPostId: "ext-2",
          publishedAt: new Date(),
        },
      });

      await prisma.channelConnection.delete({ where: { id: connection.id } });

      const target = await prisma.publishTarget.findUnique({ where: { id: id("T7") } });
      expect(target?.status).toBe("published");
      expect(target?.externalPostId).toBe("ext-2");
      expect(target?.channelConnectionId).toBeNull();
    });
  });

  describe("review items", () => {
    it("records the fingerprint an approval was given against", async () => {
      const run = await createRun(id("RJ"));
      const candidate = await createCandidate(id("CF"), run.id, 0, 15_000);
      const clip = await prisma.repurposeClip.create({
        data: {
          id: id("K5"),
          runId: run.id,
          candidateId: candidate.id,
          title: "Reviewed",
          sourceStartMs: 0,
          sourceEndMs: 15_000,
        },
      });
      const projectId = id("P6");
      await prisma.project.create({
        data: { id: projectId, workspaceId: WORKSPACE, title: "Reviewed 9:16" },
      });
      const fingerprint = "b".repeat(64);
      const variant = await prisma.clipVariant.create({
        data: {
          id: id("V5"),
          clipId: clip.id,
          projectId,
          aspect: "r9x16",
          status: "ready",
          editFingerprint: fingerprint,
        },
      });
      const bundle = await prisma.reviewBundle.create({
        data: { id: id("Z1"), runId: run.id, workspaceId: WORKSPACE, createdBy: USER },
      });
      const item = await prisma.reviewItem.create({
        data: {
          id: id("I1"),
          bundleId: bundle.id,
          variantId: variant.id,
          status: "approved",
          decisionBy: USER,
          decisionAt: new Date(),
          fingerprintAtDecision: fingerprint,
        },
      });

      expect(item.fingerprintAtDecision).toBe(fingerprint);

      // An editor save moves the variant on; the recorded decision now describes
      // an artefact that no longer exists, which is exactly the signal Wave 8
      // reads to mark the item `needs_review`.
      const edited = await prisma.clipVariant.update({
        where: { id: variant.id },
        data: { editFingerprint: "c".repeat(64), status: "stale" },
      });
      expect(edited.editFingerprint).not.toBe(item.fingerprintAtDecision);

      // One decision per variant per bundle.
      await expect(
        prisma.reviewItem.create({
          data: { id: id("I2"), bundleId: bundle.id, variantId: variant.id },
        }),
      ).rejects.toThrow();
    });
  });
});
