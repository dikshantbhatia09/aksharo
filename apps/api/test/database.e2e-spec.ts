/**
 * Integration suite against a real PostgreSQL: the schema, the hand SQL, the seed
 * and one repository round trip.
 *
 * Everything here is a claim the A03 acceptance criteria make, expressed as a test:
 *   * every table in `06-data-model.md` exists (criterion 2);
 *   * the CHECK constraints and unique indexes reject what they are supposed to
 *     reject (criterion 3) — asserted by expecting failures, not by reading DDL;
 *   * `db:seed` is idempotent (criterion 1);
 *   * segments come back in `seq` order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareSeqKeys, ItemStateSchema, PassStatusSchema, seqBetween } from "@montaj/edg";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { seed } from "../prisma/seed.js";

import type { TestDatabase } from "./db-harness.js";
import type { Prisma, PrismaClient } from "@prisma/client";

// Evaluated at collection time: `describe.skipIf` needs an answer before the first
// hook runs, and this package is CommonJS, so no top-level await.
const available = isDatabaseAvailable();

if (!available) {
  console.warn(
    "[database.e2e] SKIPPED - no test database. " +
      "Set TEST_DATABASE_URL, or start Docker so testcontainers can run " +
      `pgvector/pgvector:pg16. Reason: ${skipReason}`,
  );
}

let db: TestDatabase;

/**
 * Every table in `03-architecture/06-data-model.md`, written out by hand.
 *
 * This list is the point of the test: it is transcribed from the document, not
 * derived from the schema, so a table dropped from `schema.prisma` fails here
 * instead of quietly disappearing.
 */
const TABLES_FROM_06 = [
  // Identity & tenancy
  "users",
  "consent_records",
  "dsr_requests",
  "breach_incidents",
  "access_logs",
  "identities",
  "sessions",
  "workspaces",
  "memberships",
  "devices",
  "license_keys",
  "api_keys",
  "device_codes",
  "bridge_pairings",
  // Media & editing (EDG v2)
  "projects",
  "media_assets",
  "transcripts",
  "transcript_chunks",
  "edg_documents",
  "edg_segments",
  "edg_passes",
  "edg_pass_items",
  "edg_revisions",
  "edg_snapshots",
  "style_presets",
  "brand_kits",
  "fonts",
  "memory_entries",
  "share_links",
  "share_reports",
  "comments",
  // Jobs & outputs
  "jobs",
  "job_events",
  "provider_submissions",
  "export_manifests",
  "exports",
  // Billing & credits
  "plans",
  "subscriptions",
  "mandates",
  "passes_purchased",
  "invoices",
  "payments",
  "firc_records",
  "tax_registrations",
  "credit_accounts",
  "credit_lots",
  "credit_holds",
  "credit_ledger",
  // Growth
  "streak_experiments",
  "publish_events",
  "coupons",
  "affiliates",
  "referrals",
  "commissions",
  "affiliate_fy_totals",
  "payouts",
  "referral_rewards",
  // Content & ops
  "academy_lessons",
  "lesson_progress",
  "changelog_entries",
  "help_articles",
  "feature_flags",
  "audit_log",
  "webhook_endpoints",
  "webhook_deliveries",
  "audio_assets",
  "asset_usages",
  "asset_clearance_grants",
] as const;

/** Indexes and constraints the A03 brief names explicitly. */
const REQUIRED_INDEXES = [
  // From the brief, declared in schema.prisma:
  "edg_segments_edg_id_seq_idx",
  "transcript_chunks_transcript_id_revision_chunk_idx_key",
  "invoices_series_fiscal_year_number_key",
  // From the brief, hand SQL (NULLS LAST is not expressible in Prisma):
  "credit_lots_consumption_order_idx",
  // Uniqueness PostgreSQL cannot give with a NULLable column, or with a
  // predicate (one live segment per fractional key):
  "style_presets_system_key_key",
  "edg_segments_live_seq_idx",
  // pgvector:
  "audio_assets_embedding_hnsw_idx",
  // A08b (prisma/sql/0005-a08b-dlq.sql): one LIVE job per (workspace, jobKey),
  // and the pending slice of the dead-letter queue.
  "jobs_live_workspace_job_key_key",
  "dlq_pending_idx",
  "jobs_dlq_idx",
] as const;

/** Indexes a later work package replaced. Their absence is the assertion. */
const REMOVED_INDEXES = [
  // A08 scoped `jobKey` uniqueness globally rather than per workspace; A08b
  // replaced it with `jobs_live_workspace_job_key_key`.
  "jobs_live_job_key_key",
] as const;

const REQUIRED_CHECKS = [
  "mandates_upi_cap_check",
  "credit_lots_remaining_non_negative_check",
  "credit_accounts_balance_non_negative_check",
  "invoices_india_state_code_check",
] as const;

const ULID_A = "01JQ0000000000000000000001";

/** Distinct ULID-shaped ids, 26 chars, so nothing collides between tests. */
function id(suffix: string): string {
  return (ULID_A.slice(0, 26 - suffix.length) + suffix).toUpperCase();
}

describe.skipIf(!available)("database schema and seed", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error(`no test database: ${skipReason}`);
    db = created;
    prisma = db.prisma;
  });

  afterAll(async () => {
    await db?.stop();
  });

  describe("migrations and hand SQL", () => {
    it("creates every table named in 06-data-model.md", async () => {
      const rows = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      const present = new Set(rows.map((row) => row.table_name));

      const missing = TABLES_FROM_06.filter((table) => !present.has(table));
      expect(missing).toEqual([]);
      expect(TABLES_FROM_06).toHaveLength(68);
    });

    it("adds the A08b tables and columns 06 does not list", async () => {
      // `dlq` is not in 06-data-model.md: D46 calls for "DLQ with admin replay"
      // and A08b is where that table lands, so it is asserted separately rather
      // than smuggled into TABLES_FROM_06.
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'dlq'`;
      expect(tables).toHaveLength(1);

      const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'jobs' AND column_name IN ('dlq', 'dlq_reason', 'dlq_at', 'attempt_no'))
            OR (table_name = 'users' AND column_name = 'is_admin')
          )`;
      expect(columns.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
        "jobs.attempt_no",
        "jobs.dlq",
        "jobs.dlq_at",
        "jobs.dlq_reason",
        "users.is_admin",
      ]);
    });

    it("adds the A06 folders table, its FK and the upload columns", async () => {
      // `folders` is not in 06-data-model.md either: 06 lists `projects.folder_id`
      // but has no table for it, so A03 left the column without a foreign key and
      // A06 introduces the table and converts it. Asserted separately, for the
      // same reason `dlq` is.
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'folders'`;
      expect(tables).toHaveLength(1);

      const foreignKey = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'projects'::regclass AND conname = 'projects_folder_id_fkey'`;
      expect(foreignKey).toHaveLength(1);

      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'media_assets'
          AND column_name IN (
            'filename', 'upload_id', 'part_size_bytes', 'needs_realign',
            'thumb_keys', 'raw_purged_at', 'derived_purged_at'
          )`;
      expect(columns.map((row) => row.column_name).sort()).toEqual([
        "derived_purged_at",
        "filename",
        "needs_realign",
        "part_size_bytes",
        "raw_purged_at",
        "thumb_keys",
        "upload_id",
      ]);

      const role = await prisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = '"MediaRole"'::regtype AND enumlabel = 'subtitle'`;
      expect(role).toHaveLength(1);
    });

    it("installs the vector extension and types audio_assets.embedding as vector", async () => {
      const extensions = await prisma.$queryRaw<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      expect(extensions).toHaveLength(1);

      const column = await prisma.$queryRaw<{ udt_name: string }[]>`
        SELECT udt_name FROM information_schema.columns
        WHERE table_name = 'audio_assets' AND column_name = 'embedding'`;
      expect(column[0]?.udt_name).toBe("vector");
    });

    it("creates the indexes the brief names", async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const present = new Set(rows.map((row) => row.indexname));
      expect(REQUIRED_INDEXES.filter((name) => !present.has(name))).toEqual([]);
      expect(REMOVED_INDEXES.filter((name) => present.has(name))).toEqual([]);
    });

    it("scopes the live `jobKey` uniqueness to the workspace (A08b)", async () => {
      const [row] = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'jobs_live_workspace_job_key_key'`;
      expect(row?.indexdef).toContain("workspace_id");
      expect(row?.indexdef).toContain("job_key");
      // The predicate is the whole point: a finished job may reuse the key.
      expect(row?.indexdef).toMatch(/WHERE .*queued.*running/s);
    });

    it("creates the CHECK constraints the brief names", async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE contype = 'c'`;
      const present = new Set(rows.map((row) => row.conname));
      expect(REQUIRED_CHECKS.filter((name) => !present.has(name))).toEqual([]);
    });

    it("records the 30-day retention rule as a comment on job_events", async () => {
      const rows = await prisma.$queryRaw<{ description: string | null }[]>`
        SELECT obj_description('job_events'::regclass, 'pg_class') AS description`;
      expect(rows[0]?.description).toMatch(/30 days/i);
    });

    it("keeps the EDG enums identical to @montaj/edg, the source of truth", async () => {
      // A03 wrote `PassStatus.succeeded` by analogy with `JobStatus`; the package
      // says `ready`, because a pass whose job succeeded is not finished — its
      // items are awaiting review. Comparing as SETS, because a PostgreSQL enum
      // carries a sort order that `ALTER TYPE … RENAME VALUE` preserves in place
      // and Prisma does not model.
      const labelsOf = async (typeName: string): Promise<string[]> => {
        const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
          SELECT e.enumlabel FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = ${typeName}`;
        return rows.map((row) => row.enumlabel).sort();
      };

      expect(await labelsOf("PassStatus")).toEqual([...PassStatusSchema.options].sort());
      expect(await labelsOf("ItemState")).toEqual([...ItemStateSchema.options].sort());

      // JobStatus is a different lifecycle and keeps `succeeded`: it mirrors the
      // completion callback of CONTRACTS §3, not the pass review state.
      expect(await labelsOf("JobStatus")).toContain("succeeded");
      expect(await labelsOf("PassStatus")).not.toContain("succeeded");
    });

    it("stores timestamps as timestamptz, never timestamp", async () => {
      const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;
      expect(rows).toEqual([]);
    });

    it("re-applying the hand SQL is a no-op", async () => {
      const { applySql } = await import("../scripts/apply-sql.js");
      const applied = await applySql(db.url);
      expect(applied.length).toBeGreaterThanOrEqual(4);
      // Same files, same checksums: nothing changed on the second pass.
      expect(applied.every((file) => !file.changed)).toBe(true);
    });
  });

  describe("constraints reject what they must", () => {
    it("refuses a UPI Autopay mandate above Rs 15,000", async () => {
      const workspace = await makeWorkspace(prisma, "upi");

      const withinCap = prisma.mandate.create({
        data: {
          id: id("M1"),
          workspaceId: workspace.id,
          method: "upi_autopay",
          maxAmountMinor: 1_500_000,
        },
      });
      await expect(withinCap).resolves.toBeTruthy();

      const overCap = prisma.mandate.create({
        data: {
          id: id("M2"),
          workspaceId: workspace.id,
          method: "upi_autopay",
          maxAmountMinor: 1_500_001,
        },
      });
      await expect(overCap).rejects.toThrow(/mandates_upi_cap_check/);

      // The same amount on a card mandate is fine: the cap is a UPI rule (D40).
      const card = prisma.mandate.create({
        data: {
          id: id("M3"),
          workspaceId: workspace.id,
          method: "card",
          maxAmountMinor: 5_000_000,
        },
      });
      await expect(card).resolves.toBeTruthy();
    });

    it("refuses a negative credit balance and an over-consumed lot", async () => {
      const workspace = await makeWorkspace(prisma, "cr");
      const account = await prisma.creditAccount.create({
        data: { id: id("CA"), workspaceId: workspace.id, balanceTenths: 100 },
      });

      await expect(
        prisma.creditAccount.update({
          where: { id: account.id },
          data: { balanceTenths: -1 },
        }),
      ).rejects.toThrow(/credit_accounts_balance_non_negative_check/);

      await expect(
        prisma.creditLot.create({
          data: {
            id: id("L1"),
            accountId: account.id,
            source: "grant",
            grantedTenths: 100,
            remainingTenths: -1,
          },
        }),
      ).rejects.toThrow(/credit_lots_remaining_non_negative_check/);
    });

    it("requires a state code on an invoice to an Indian recipient", async () => {
      const workspace = await makeWorkspace(prisma, "inv");

      const base = {
        workspaceId: workspace.id,
        series: "AK",
        fiscalYear: "2026-27",
        supplierLegalName: "Supplier",
        recipientLegalName: "Recipient",
        recipientCountry: "IN",
        placeOfSupplyCountry: "IN",
        supplyType: "intra_state" as const,
        sacCode: "998434",
        itemDescription: "Subscription",
      };

      await expect(
        prisma.invoice.create({ data: { ...base, id: id("I1"), number: "AK000001" } }),
      ).rejects.toThrow(/invoices_india_state_code_check/);

      await expect(
        prisma.invoice.create({
          data: { ...base, id: id("I2"), number: "AK000002", recipientStateCode: "27" },
        }),
      ).resolves.toBeTruthy();

      // A US recipient needs no state code: the rule is Indian (D41).
      await expect(
        prisma.invoice.create({
          data: {
            ...base,
            id: id("I3"),
            number: "AK000003",
            recipientCountry: "US",
            placeOfSupplyCountry: "US",
            supplyType: "export",
            exportEndorsementText: "Supply meant for export under LUT without payment of IGST",
            docType: "export_invoice",
          },
        }),
      ).resolves.toBeTruthy();
    });

    it("keeps (series, fiscalYear, number) unique on invoices", async () => {
      const workspace = await makeWorkspace(prisma, "dup");
      const data = {
        workspaceId: workspace.id,
        series: "DUP",
        fiscalYear: "2026-27",
        number: "DUP00001",
        supplierLegalName: "Supplier",
        recipientLegalName: "Recipient",
        recipientCountry: "IN",
        recipientStateCode: "27",
        placeOfSupplyCountry: "IN",
        supplyType: "intra_state" as const,
        sacCode: "998434",
        itemDescription: "Subscription",
      };

      await prisma.invoice.create({ data: { ...data, id: id("D1") } });
      await expect(prisma.invoice.create({ data: { ...data, id: id("D2") } })).rejects.toThrow(
        /Unique constraint|invoices_series_fiscal_year_number_key/,
      );
    });

    it("keeps (transcriptId, revision, chunkIdx) unique on transcript chunks", async () => {
      const { project } = await makeProject(prisma, "tc");
      const transcript = await prisma.transcript.create({
        data: { id: id("T1"), projectId: project.id, language: "hi-IN" },
      });

      const chunk = {
        transcriptId: transcript.id,
        revision: 1,
        chunkIdx: 0,
        startMs: 0,
        endMs: 1_000,
      };
      await prisma.transcriptChunk.create({ data: { ...chunk, id: id("C1") } });
      await expect(
        prisma.transcriptChunk.create({ data: { ...chunk, id: id("C2") } }),
      ).rejects.toThrow(/Unique constraint|transcript_chunks_transcript_id_revision_chunk_idx_key/);
    });

    it("stops two system style presets sharing a key", async () => {
      // `@@unique([workspaceId, key])` cannot do this: every NULL is distinct.
      await prisma.stylePreset.create({
        data: { id: id("S1"), workspaceId: null, key: "duplicate-probe", name: "First" },
      });
      await expect(
        prisma.stylePreset.create({
          data: { id: id("S2"), workspaceId: null, key: "duplicate-probe", name: "Second" },
        }),
      ).rejects.toThrow(/style_presets_system_key_key|Unique constraint/);
    });
  });

  describe("seed", () => {
    it("is idempotent: running it twice leaves the counts unchanged", async () => {
      const first = await seed(prisma);
      const countsAfterFirst = await counts(prisma);

      const second = await seed(prisma);
      const countsAfterSecond = await counts(prisma);

      expect(second).toEqual(first);
      expect(countsAfterSecond).toEqual(countsAfterFirst);
    });

    it("seeds the five plans with prices, credits and entitlements", async () => {
      await seed(prisma);
      const plans = await prisma.plan.findMany({ orderBy: { creditsPerMonthTenths: "asc" } });

      expect(plans.map((plan) => plan.key)).toEqual([
        "free",
        "starter",
        "creator",
        "agency",
        "studio",
      ]);

      const creator = plans.find((plan) => plan.key === "creator");
      // 500 credits/month = 5000 tenths (CONTRACTS §0).
      expect(creator?.creditsPerMonthTenths).toBe(5_000);
      expect(creator?.prices).toMatchObject({ INR: { month: 69_900 }, USD: { month: 1_900 } });
      // Audio clean is Creator+ in the burn-rate table, so the derived gate says yes.
      expect(
        (creator?.entitlements as Record<string, Record<string, boolean>>)["operations"],
      ).toMatchObject({
        audioClean: true,
        sfxMusicPass: false,
      });

      const free = plans.find((plan) => plan.key === "free");
      expect(
        (free?.entitlements as Record<string, Record<string, boolean>>)["operations"],
      ).toMatchObject({
        transcription: true,
        audioClean: false,
      });
    });

    it("leaves the parity flags at their pessimistic defaults", async () => {
      await seed(prisma);
      const styles = await prisma.stylePreset.findMany({ where: { workspaceId: null } });
      expect(styles.length).toBeGreaterThanOrEqual(5);
      for (const style of styles) {
        // Only the A18a parity gate may write these (D33).
        expect(style.assRenderable).toBe(false);
        expect(style.assExportable).toBe(false);
        expect(style.requiresLayoutMetrics).toBe(true);
        expect(style.parityScore).toBeNull();
      }
    });

    it("seeds four feature flags, all off", async () => {
      await seed(prisma);
      const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
      expect(flags.map((flag) => flag.key)).toEqual([
        "local_mode",
        "partner_audio",
        "provider_bhashini",
        "streak_experiment",
      ]);
      expect(flags.every((flag) => !flag.enabled && flag.rolloutPct === 0)).toBe(true);
    });

    it("seeds a demo workspace whose credits satisfy invariant 1", async () => {
      await seed(prisma);
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { slug: "demo" },
        include: { creditAccount: { include: { lots: true, ledger: true } }, subscriptions: true },
      });

      const account = workspace.creditAccount;
      const lotSum = (account?.lots ?? []).reduce((sum, lot) => sum + lot.remainingTenths, 0);
      const ledgerSum = (account?.ledger ?? []).reduce((sum, row) => sum + row.deltaTenths, 0);

      // balance = Σ lot remainders = Σ ledger deltas (06 invariant 1).
      expect(account?.balanceTenths).toBe(lotSum);
      expect(account?.balanceTenths).toBe(ledgerSum);
      // Free plan: 20 credits = 200 tenths.
      expect(account?.balanceTenths).toBe(200);
      expect(workspace.subscriptions).toHaveLength(1);
      expect(workspace.billingStateCode).toBe("27");
    });
  });

  describe("repository smoke test", () => {
    it("writes a project, an EDG document and three segments, and reads them back in seq order", async () => {
      const { project } = await makeProject(prisma, "sm");

      const edg = await prisma.edgDocument.create({
        data: {
          id: id("E1"),
          projectId: project.id,
          revision: 1,
          doc: { meta: { schemaVersion: 2 } } as Prisma.InputJsonValue,
        },
      });

      // Real keys from `@montaj/edg`, inserted out of order on purpose: `seq` is
      // what defines document order, not insertion order. `seqBetween(a, b)` is
      // the operation that has to keep working — inserting between two
      // neighbours must not renumber either of them.
      const first = seqBetween();
      const third = seqBetween(first);
      const second = seqBetween(first, third);
      expect(compareSeqKeys(first, second)).toBeLessThan(0);
      expect(compareSeqKeys(second, third)).toBeLessThan(0);

      const segments: [string, string, number, number][] = [
        [id("G2"), third, 2_000, 3_000],
        [id("G3"), second, 1_000, 2_000],
        [id("G1"), first, 0, 1_000],
      ];
      for (const [segmentId, seq, startMs, endMs] of segments) {
        await prisma.edgSegment.create({
          data: {
            id: segmentId,
            edgId: edg.id,
            seq,
            startWordId: `0:${startMs / 1000}`,
            endWordId: `0:${endMs / 1000}`,
            startMs,
            endMs,
          },
        });
      }

      const read = await prisma.edgSegment.findMany({
        where: { edgId: edg.id },
        orderBy: { seq: "asc" },
      });

      expect(read).toHaveLength(3);
      expect(read.map((segment) => segment.seq)).toEqual([first, second, third]);
      expect(read.map((segment) => segment.startMs)).toEqual([0, 1_000, 2_000]);
      // A fractional index has to survive the round trip exactly, or reordering
      // silently corrupts the document.
      expect(read[1]?.id).toBe(id("G3"));
    });

    it("orders seq by bytes, exactly as @montaj/edg compares keys", async () => {
      const { project } = await makeProject(prisma, "co");
      const edg = await prisma.edgDocument.create({
        data: { id: id("E3"), projectId: project.id },
      });

      // These six keys separate byte order from a linguistic one. Measured on the
      // very image this suite runs (`pgvector/pgvector:pg16`, whose database
      // default is en_US.utf8, NOT C):
      //
      //   ORDER BY seq                -> 1 1B 2 a Zz zzzV
      //   ORDER BY seq COLLATE "C"    -> 1 1B 2 Zz a zzzV
      //
      // So a column that inherited the database default fails here, and nowhere
      // else until a user reports their captions coming out shuffled.
      const keys = ["1", "1B", "2", "Zz", "a", "zzzV"];
      let index = 0;
      for (const seq of [...keys].reverse()) {
        index += 1;
        await prisma.edgSegment.create({
          data: {
            id: id(`H${index}`),
            edgId: edg.id,
            seq,
            startWordId: "0:0",
            endWordId: "0:1",
            startMs: 0,
            endMs: 1_000,
          },
        });
      }

      const read = await prisma.edgSegment.findMany({
        where: { edgId: edg.id },
        orderBy: { seq: "asc" },
        select: { seq: true },
      });

      const expected = [...keys].sort(compareSeqKeys);
      expect(read.map((segment) => segment.seq)).toEqual(expected);
      // …and the sort the package would do is the identity on this input, so the
      // assertion above really is "Postgres agrees with @montaj/edg".
      expect(expected).toEqual(keys);
    });

    it('pins COLLATE "C" on the column, not on the database default', async () => {
      // Managed Postgres usually defaults to a linguistic collation, and so does
      // the image this suite runs on. `collation_name` is NULL for a column that
      // inherits the database default, so this is not a tautology: it is `C` only
      // because the migration pins it.
      const rows = await prisma.$queryRaw<{ collation_name: string | null }[]>`
        SELECT collation_name FROM information_schema.columns
        WHERE table_name = 'edg_segments' AND column_name = 'seq'`;
      expect(rows[0]?.collation_name).toBe("C");
    });

    it("refuses two live segments on the same seq", async () => {
      const { project } = await makeProject(prisma, "uq");
      const edg = await prisma.edgDocument.create({
        data: { id: id("E4"), projectId: project.id },
      });
      const row = (segmentId: string, seq: string, deletedAtRev: number | null) => ({
        id: segmentId,
        edgId: edg.id,
        seq,
        startWordId: "0:0",
        endWordId: "0:1",
        startMs: 0,
        endMs: 1_000,
        deletedAtRev,
      });

      await prisma.edgSegment.create({ data: row(id("J1"), "V", null) });
      // Two live segments claiming one position leaves the document with no
      // defined order.
      await expect(prisma.edgSegment.create({ data: row(id("J2"), "V", null) })).rejects.toThrow(
        /edg_segments_live_seq_idx|Unique constraint/,
      );

      // A tombstone on the same key is fine: ids are never reused, so a deleted
      // segment keeps its key while a later edit may legitimately reclaim it.
      await prisma.edgSegment.update({
        where: { id: id("J1") },
        data: { deletedAtRev: 7 },
      });
      await expect(
        prisma.edgSegment.create({ data: row(id("J3"), "V", null) }),
      ).resolves.toBeTruthy();
      await expect(prisma.edgSegment.create({ data: row(id("J4"), "V", 9) })).resolves.toBeTruthy();
    });

    it("cascades a project delete to its EDG document and segments", async () => {
      const { project } = await makeProject(prisma, "cx");
      const edg = await prisma.edgDocument.create({
        data: { id: id("E2"), projectId: project.id },
      });
      await prisma.edgSegment.create({
        data: {
          id: id("G4"),
          edgId: edg.id,
          seq: "1",
          startWordId: "0:0",
          endWordId: "0:1",
          startMs: 0,
          endMs: 500,
        },
      });

      await prisma.project.delete({ where: { id: project.id } });

      expect(await prisma.edgDocument.findUnique({ where: { id: edg.id } })).toBeNull();
      expect(await prisma.edgSegment.findUnique({ where: { id: id("G4") } })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function counts(prisma: PrismaClient): Promise<Record<string, number>> {
  const [
    plans,
    styles,
    flags,
    users,
    workspaces,
    memberships,
    accounts,
    lots,
    ledger,
    subscriptions,
  ] = await Promise.all([
    prisma.plan.count(),
    prisma.stylePreset.count(),
    prisma.featureFlag.count(),
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.membership.count(),
    prisma.creditAccount.count(),
    prisma.creditLot.count(),
    prisma.creditLedger.count(),
    prisma.subscription.count(),
  ]);
  return {
    plans,
    styles,
    flags,
    users,
    workspaces,
    memberships,
    accounts,
    lots,
    ledger,
    subscriptions,
  };
}

async function makeWorkspace(prisma: PrismaClient, tag: string) {
  const user = await prisma.user.create({
    data: { id: id(`U${tag}`), email: `${tag}@example.test` },
  });
  return prisma.workspace.create({
    data: {
      id: id(`W${tag}`),
      slug: `ws-${tag}`,
      name: `Workspace ${tag}`,
      ownerId: user.id,
      billingCountry: "IN",
      billingStateCode: "27",
    },
  });
}

async function makeProject(prisma: PrismaClient, tag: string) {
  const workspace = await makeWorkspace(prisma, tag);
  const project = await prisma.project.create({
    data: { id: id(`P${tag}`), workspaceId: workspace.id, title: `Project ${tag}` },
  });
  return { workspace, project };
}
