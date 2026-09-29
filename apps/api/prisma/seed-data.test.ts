import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BURN_RATES, TENTHS_PER_CREDIT } from "@montaj/config";

import {
  FEATURE_FLAG_SEEDS,
  MAX_SOURCE_DURATION_MS,
  loadSystemStyles,
  operationsFor,
  parityOf,
  PLAN_LADDER,
  PLAN_SEEDS,
  planMeets,
  seedUlid,
} from "./seed-data.js";
import { listSqlFiles } from "../scripts/apply-sql.js";
import { PLAN_ENQUEUED_CAP_TENTHS } from "../src/jobs/jobs.config.js";
import { WINDOW_TOLERANCE_MS } from "../src/repurpose/repurpose.constants.js";
import { quoteTranscription } from "../src/transcripts/transcripts.quote.js";
import { INTERNAL_UNLIMITED_ENTITLEMENTS } from "../src/workspaces/entitlement.service.js";

import type { StylesModuleLoader } from "./seed-data.js";

describe("seedUlid", () => {
  it("is a 26-character ULID", () => {
    expect(seedUlid("plan:free")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is stable across calls, which is what makes the seed idempotent", () => {
    expect(seedUlid("plan:free")).toBe(seedUlid("plan:free"));
  });

  it("is different for different names", () => {
    expect(seedUlid("plan:free")).not.toBe(seedUlid("plan:starter"));
  });
});

describe("planMeets", () => {
  it("is true for every plan when there is no minimum", () => {
    for (const plan of PLAN_LADDER) expect(planMeets(plan, null)).toBe(true);
  });

  it("compares by position on the ladder", () => {
    expect(planMeets("free", "creator")).toBe(false);
    expect(planMeets("creator", "creator")).toBe(true);
    expect(planMeets("studio", "creator")).toBe(true);
    expect(planMeets("agency", "studio")).toBe(true);
  });
});

describe("operationsFor", () => {
  it("derives the gate from the burn-rate table rather than restating it", () => {
    // 04 §Credits: audio clean is Creator+, SFX/music is Studio+.
    expect(operationsFor("free").transcription).toBe(true);
    expect(operationsFor("free").audioClean).toBe(false);
    expect(operationsFor("creator").audioClean).toBe(true);
    expect(operationsFor("creator").sfxMusicPass).toBe(false);
    expect(operationsFor("studio").sfxMusicPass).toBe(true);
  });

  it("covers every operation in the table", () => {
    expect(Object.keys(operationsFor("agency")).sort()).toEqual(Object.keys(BURN_RATES).sort());
  });
});

describe("PLAN_SEEDS", () => {
  it("has the five plans of 04 §Plans, in ladder order", () => {
    expect(PLAN_SEEDS.map((plan) => plan.key)).toEqual([...PLAN_LADDER]);
  });

  it("prices the ladder as printed, in minor units inclusive of GST", () => {
    const price = (key: string, currency: "INR" | "USD", term: "month" | "year") =>
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      (
        PLAN_SEEDS.find((plan) => plan.key === key)?.prices as Record<
          string,
          Record<string, number>
        >
      )[currency]?.[term];

    expect(price("free", "INR", "month")).toBe(0);
    expect(price("starter", "INR", "month")).toBe(29_900);
    expect(price("creator", "INR", "month")).toBe(69_900);
    expect(price("studio", "INR", "month")).toBe(199_900);
    expect(price("agency", "INR", "month")).toBe(119_900);

    expect(price("creator", "USD", "month")).toBe(1_900);
    // 04: "Creator yearly (₹6,984)".
    expect(price("creator", "INR", "year")).toBe(698_400);
    // 04: "Studio yearly (₹19,992)".
    expect(price("studio", "INR", "year")).toBe(1_999_200);
    // 04: "Agency yearly per seat (₹11,988)".
    expect(price("agency", "INR", "year")).toBe(1_198_800);
  });

  it("sells Studio yearly as two half-yearly debits, because of the UPI cap", () => {
    const studio = PLAN_SEEDS.find((plan) => plan.key === "studio");
    const inr = (studio?.prices as Record<string, Record<string, number>>)["INR"];
    // ₹19,992 exceeds the ₹15,000 UPI mandate cap; ₹9,996 does not (04 §Yearly, D40).
    expect(inr?.["halfyear"]).toBe(999_600);
    expect(inr?.["halfyear"]).toBeLessThanOrEqual(1_500_000);
  });

  it("grants credits in tenths", () => {
    const credits = (key: string) =>
      PLAN_SEEDS.find((plan) => plan.key === key)?.creditsPerMonthTenths;
    // 200 during the beta (2026-09-29); 04 §Plans says 20.
    expect(credits("free")).toBe(200 * TENTHS_PER_CREDIT);
    expect(credits("starter")).toBe(150 * TENTHS_PER_CREDIT);
    expect(credits("creator")).toBe(500 * TENTHS_PER_CREDIT);
    expect(credits("studio")).toBe(1_800 * TENTHS_PER_CREDIT);
    expect(credits("agency")).toBe(900 * TENTHS_PER_CREDIT);
  });

  it("carries the retention row of 04 §Plans into the entitlements", () => {
    const retention = (key: string) =>
      (PLAN_SEEDS.find((plan) => plan.key === key)?.entitlements as Record<string, number>)[
        "retentionDays"
      ];
    expect([
      retention("free"),
      retention("starter"),
      retention("creator"),
      retention("studio"),
    ]).toEqual([7, 30, 90, 365]);
  });

  it("watermarks only the free plan", () => {
    for (const plan of PLAN_SEEDS) {
      const watermark = (plan.entitlements as Record<string, string>)["watermark"];
      expect(watermark, plan.key).toBe(plan.key === "free" ? "after_first_clean_export" : "none");
    }
  });
});

describe("FEATURE_FLAG_SEEDS", () => {
  it("contains the established and repurposing rollout flags", () => {
    expect(FEATURE_FLAG_SEEDS.map((flag) => flag.key).sort()).toEqual([
      "highlight_discovery",
      "local_mode",
      "partner_audio",
      "provider_bhashini",
      "publishing_postiz",
      "publishing_tiktok",
      "repurpose_automations",
      "repurpose_dubbing",
      "repurpose_flow",
      "source_youtube_acquire",
      "streak_experiment",
    ]);
  });

  it("explains why each one exists", () => {
    for (const flag of FEATURE_FLAG_SEEDS) {
      expect(flag.description.length, flag.key).toBeGreaterThan(20);
    }
  });
});

describe("loadSystemStyles", () => {
  /** A loader that behaves as if `@montaj/caption-styles` cannot be resolved. */
  const noPackage: StylesModuleLoader = () => undefined;

  it("prefers the package catalogue, which is what production uses", () => {
    // The real `@montaj/caption-styles`, resolved exactly as the seed resolves it.
    const { source, styles } = loadSystemStyles();

    expect(source).toBe("package");
    // A02 ships seven styles today; A16 adds the rest of the 30+ (F-305).
    expect(styles.length).toBeGreaterThanOrEqual(7);
    expect(styles.map((style) => style.key)).toContain("punch-pop");
    // `registry.json` is the catalogue index, never a style.
    expect(styles.map((style) => style.key)).not.toContain("registry");
    // The whole StyleDoc lands in `style_presets.doc`.
    expect(styles[0]?.doc).toMatchObject({ version: 2 });
  });

  it("reads the A18a parity gate's flags off each style document (D33)", () => {
    // This checkout's `packages/caption-styles/styles/*.json` has already had
    // `pnpm --filter @montaj/ass-exporter parity` run against it, so every
    // style carries a real measured `parity` row, not the pre-gate defaults.
    const { styles } = loadSystemStyles();
    const nonAssExportable = new Set([
      "editorial-ghost-type",
      "editorial-keyword-zoom",
      "editorial-stack",
    ]);
    for (const style of styles) {
      expect(style.parity, style.key).toBeDefined();
      if (nonAssExportable.has(style.key)) {
        expect(style.parity?.assExportable, style.key).toBe(false);
      } else {
        expect(style.parity?.assExportable, style.key).toBe(true);
      }
      expect(typeof style.parity?.assRenderable, style.key).toBe("boolean");
      if (nonAssExportable.has(style.key)) {
        expect(style.parity?.parityScore, style.key).toBeUndefined();
      } else {
        expect(style.parity?.parityScore, style.key).toBeGreaterThanOrEqual(0);
        expect(style.parity?.parityScore, style.key).toBeLessThanOrEqual(1);
      }
    }
  });

  it("parityOf returns undefined for a document with no parity fields at all", () => {
    expect(parityOf({ id: "no-flags" })).toBeUndefined();
  });

  it("falls back to the placeholders when the package cannot be resolved", () => {
    // An empty temp directory stands in for a repo root without
    // `packages/caption-styles/styles`.
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    const { source, styles } = loadSystemStyles(empty, noPackage);

    expect(source).toBe("fallback");
    expect(styles).toHaveLength(5);
    expect(styles.map((style) => style.key)).toEqual([
      "punch-pop",
      "hype-bold",
      "karaoke-fill",
      "word-pop",
      "minimal-lower-third",
    ]);
  });

  it("falls back when the package resolves but exports no loader", () => {
    // What a checkout with an unbuilt `dist/` looks like from here.
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    expect(loadSystemStyles(empty, () => ({})).source).toBe("fallback");
  });

  it("falls back when the package exports an empty catalogue", () => {
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    const emptyCatalogue: StylesModuleLoader = () => ({ loadSystemStyles: () => [] });
    expect(loadSystemStyles(empty, emptyCatalogue).source).toBe("fallback");
  });

  it("names styles after the look, never a person or a brand (F-305)", () => {
    const empty = mkdtempSync(join(tmpdir(), "montaj-styles-"));
    for (const style of loadSystemStyles(empty, noPackage).styles) {
      expect(style.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    // The same rule holds for the real catalogue, which the package enforces (D64).
    for (const style of loadSystemStyles().styles) {
      expect(style.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("reads packages/caption-styles/styles/*.json when the package is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "montaj-repo-"));
    const dir = join(root, "packages", "caption-styles", "styles");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(
      join(dir, "bubble.json"),
      JSON.stringify({ id: "bubble", version: 2, name: "Bubble", category: "playful" }),
    );
    // No `name`: the key falls back to the filename.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(join(dir, "glow.json"), JSON.stringify({ id: "glow", version: 2 }));

    const { source, styles } = loadSystemStyles(root, noPackage);

    expect(source).toBe("fixtures");
    expect(styles.map((style) => style.key)).toEqual(["bubble", "glow"]);
    expect(styles[0]?.name).toBe("Bubble");
    expect(styles[1]?.name).toBe("glow");
    expect(styles[1]?.doc).toMatchObject({ id: "glow", version: 2 });
  });

  it("skips registry.json and anything else that is not a StyleDoc v2", () => {
    const root = mkdtempSync(join(tmpdir(), "montaj-repo-"));
    const dir = join(root, "packages", "caption-styles", "styles");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    mkdirSync(dir, { recursive: true });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(
      join(dir, "bubble.json"),
      JSON.stringify({ id: "bubble", version: 2, name: "Bubble", category: "playful" }),
    );
    // The catalogue index that A02 ships alongside the styles.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({ version: 1, styles: [{ id: "bubble", status: "shipped" }] }),
    );
    // A v1 document, an id-less one, and a file that is not JSON at all.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(join(dir, "legacy.json"), JSON.stringify({ id: "legacy", version: 1 }));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(join(dir, "anonymous.json"), JSON.stringify({ version: 2 }));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(join(dir, "broken.json"), "{ not json");

    const { source, styles } = loadSystemStyles(root, noPackage);

    expect(source).toBe("fixtures");
    expect(styles.map((style) => style.key)).toEqual(["bubble"]);
  });

  it("falls back when the directory holds nothing but a registry", () => {
    const root = mkdtempSync(join(tmpdir(), "montaj-repo-"));
    const dir = join(root, "packages", "caption-styles", "styles");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 1, styles: [] }));

    // Nothing usable is not the same as "a catalogue of one registry".
    expect(loadSystemStyles(root, noPackage).source).toBe("fallback");
  });
});

describe("clips allowances (2026-09-27)", () => {
  const value = (key: string, field: string): unknown =>
    // eslint-disable-next-line security/detect-object-injection -- `field` is a literal of this test
    (PLAN_SEEDS.find((plan) => plan.key === key)?.entitlements as Record<string, unknown>)[field];
  const MIGRATION = join(__dirname, "migrations", "20260927090000_clips_windows", "migration.sql");

  it("limits the minutes a run processes, per plan, as the owner decided", () => {
    expect(PLAN_LADDER.map((key) => value(key, "clipsWindowMs"))).toEqual([
      20 * 60_000,
      60 * 60_000,
      180 * 60_000,
      360 * 60_000,
      360 * 60_000,
    ]);
  });

  it("gives every plan the same 12-hour source ceiling", () => {
    for (const key of PLAN_LADDER) {
      expect(value(key, "maxSourceDurationMs"), key).toBe(MAX_SOURCE_DURATION_MS);
    }
    expect(MAX_SOURCE_DURATION_MS).toBe(12 * 60 * 60_000);
  });

  it("fits a full window's transcription, file slack included, under the plan's enqueued cap", () => {
    // A window bigger than the cap would download, then have its transcription
    // refused "for now" by admission on every retry, and spin for good.
    for (const key of PLAN_LADDER) {
      const window = value(key, "clipsWindowMs") as number;
      expect(quoteTranscription(window + WINDOW_TOLERANCE_MS).tenths, key).toBeLessThanOrEqual(
        // eslint-disable-next-line security/detect-object-injection -- a key of PLAN_LADDER
        PLAN_ENQUEUED_CAP_TENTHS[key],
      );
    }
    // And the owner's unlimited 12 hours, on the Studio subscription it runs under.
    expect(
      quoteTranscription(INTERNAL_UNLIMITED_ENTITLEMENTS.clipsWindowMs + WINDOW_TOLERANCE_MS)
        .tenths,
    ).toBeLessThanOrEqual(PLAN_ENQUEUED_CAP_TENTHS.studio);
  });

  it("never gives a window less than the upload cap it replaces for clips", () => {
    for (const key of PLAN_LADDER) {
      expect(value(key, "clipsWindowMs") as number, key).toBeGreaterThanOrEqual(
        value(key, "maxDurationMs") as number,
      );
    }
  });

  it("matches what the clips_windows migration writes into an existing database", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const key of PLAN_LADDER) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- `key` is a plan key from PLAN_LADDER
      const match = new RegExp(
        `"clipsWindowMs": (\\d+), "maxSourceDurationMs": (\\d+)\\}'::jsonb WHERE "key" = '${key}'`,
      ).exec(sql);
      expect(match, key).not.toBeNull();
      expect(Number(match?.[1]), key).toBe(value(key, "clipsWindowMs"));
      expect(Number(match?.[2]), key).toBe(value(key, "maxSourceDurationMs"));
    }
  });

  it("keeps the Prisma migration additive: no index Prisma cannot see", () => {
    // A partial expression index in a Prisma migration lands in the shadow
    // database without `schema.prisma` knowing it, and `migrate dev` then
    // scaffolds a DROP of it (prisma/sql/README.md "Where an index belongs").
    const sql = readFileSync(MIGRATION, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bINDEX\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  describe("the live-source index, in prisma/sql", () => {
    const SQL_DIR = join(__dirname, "sql");
    const WINDOW_INDEX = "0007z-clips-window-index.sql";
    const LEGACY = "0008-rep-repurpose-publish.sql";

    it("runs BEFORE 0008, so 0008 always finds an index of that name and skips", () => {
      // With the index missing and two live windows of one video in the table,
      // 0008's old, stricter `CREATE UNIQUE INDEX IF NOT EXISTS` fails on the
      // duplicate keys and `db:migrate` stops there (measured on Postgres 16).
      const files = listSqlFiles(SQL_DIR);
      expect(files).toContain(WINDOW_INDEX);
      expect(files.indexOf(WINDOW_INDEX)).toBeLessThan(files.indexOf(LEGACY));
      expect(files.indexOf(WINDOW_INDEX)).toBe(files.indexOf("0007-b02b-credit-revoke.sql") + 1);
    });

    it("defines it under 0008's name, with the window start in the key and 0008's predicate", () => {
      const sql = readFileSync(join(SQL_DIR, WINDOW_INDEX), "utf8");
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX repurpose_runs_live_source_idx\s+ON repurpose_runs \(workspace_id, source_fingerprint, \(COALESCE\(window_start_ms, -1\)\)\)\s+WHERE source_fingerprint IS NOT NULL\s+AND status NOT IN \('published', 'failed', 'cancelled'\);/,
      );
      const legacy = readFileSync(join(SQL_DIR, LEGACY), "utf8");
      expect(legacy).toContain("CREATE UNIQUE INDEX IF NOT EXISTS repurpose_runs_live_source_idx");
      expect(legacy).toMatch(
        /WHERE source_fingerprint IS NOT NULL\s+AND status NOT IN \('published', 'failed', 'cancelled'\);/,
      );
    });

    it("replaces it only when the definition lacks the window start, in this schema", () => {
      // The statements, not the header (whose rollback note has a DROP of its own).
      const sql = readFileSync(join(SQL_DIR, WINDOW_INDEX), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      // Idempotent (every `db:migrate` re-runs it): the check reads the live
      // definition, as pg_indexes prints it, before touching anything.
      expect(sql).toMatch(/FROM pg_indexes\s+WHERE schemaname = current_schema\(\)/);
      expect(sql).toContain("indexname = 'repurpose_runs_live_source_idx'");
      expect(sql).toContain("position('COALESCE(window_start_ms' IN current_definition) = 0");
      expect(sql.indexOf("IF current_definition IS NULL")).toBeLessThan(
        sql.indexOf("DROP INDEX IF EXISTS repurpose_runs_live_source_idx"),
      );
    });
  });
});
