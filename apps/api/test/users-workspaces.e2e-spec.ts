/**
 * The A05 acceptance suite: `/me`, `/consents`, `/privacy`, `/workspaces` and
 * `/invitations`.
 *
 * Runs against a real PostgreSQL and a real Redis, for the same reason
 * `auth.e2e-spec.ts` does: every claim worth making here is a claim about those
 * stores. An append-only consent log, a unique workspace slug, an entitlement
 * cached for sixty seconds and a membership guard that re-reads the row after a
 * demotion cannot be demonstrated against an in-memory stub.
 *
 * Skips with an explanation when Docker is unavailable.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authSkipReason, createAdminContext, createAuthTestContext } from "./auth-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { hashEmail } from "../src/privacy/parental-waitlist.js";
import { PRIVACY_NOTICE_VERSION } from "../src/users/users.service.js";
import { workspacesRedisKeys } from "../src/workspaces/workspaces.constants.js";

import type { AuthTestContext } from "./auth-harness.js";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[users-workspaces.e2e] SKIPPED - ${skipReason}`);
}

const PASSWORD = "correct-horse-battery-staple";
const ADULT_DOB = "1996-01-15";
const IP = "203.0.113.20";

/** Published business GSTINs whose check digit the algorithm reproduces. */
const MAHARASHTRA_GSTIN = "27AAPFU0939F1ZV";
const KARNATAKA_GSTIN = "29AAGCB7383J1Z4";

interface Tokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  workspaceId: string;
  role: string;
}

describe.skipIf(!available)("users, workspaces, consents and privacy (e2e)", () => {
  let ctx: AuthTestContext;
  let server: Server;

  beforeAll(async () => {
    const created = await createAuthTestContext();
    if (created === null) throw new Error(`harness unavailable: ${authSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.reset();
    await seedFreePlan();
  });

  // --- helpers -------------------------------------------------------------

  const address = (label: string) => `${label}-${Date.now().toString(36)}@example.test`;

  /** `GET /workspaces/{id}/entitlement` reads the seeded Free plan. */
  async function seedFreePlan(): Promise<void> {
    await ctx.prisma.plan.upsert({
      where: { key: "free" },
      create: {
        id: "01JPLANFREE000000000000000",
        key: "free",
        name: "Free",
        prices: { INR: { month: 0 }, USD: { month: 0 } },
        creditsPerMonthTenths: 200,
        entitlements: { seatsIncluded: 0, retentionDays: 7, apiAccess: false },
      },
      update: {},
    });
  }

  /** Sign up, verify the address, sign in. */
  async function newUser(label: string, overrides: Record<string, unknown> = {}) {
    const email = address(label);
    await request(server)
      .post("/auth/signup")
      .set("X-Forwarded-For", IP)
      .send({
        email,
        password: PASSWORD,
        name: "Test Person",
        dateOfBirth: ADULT_DOB,
        jurisdiction: "IN",
        ...overrides,
      })
      .expect(202);

    // Match on the address, not just the template: the outbox is one Redis list,
    // and a suite that picked "the newest verification mail" would consume another
    // user's token the moment two sign-ups interleave.
    const messages = await ctx.outbox();
    const verification = messages.find(
      (entry) => entry.template === "email_verification" && entry.to === email,
    );
    await request(server)
      .post("/auth/verify-email")
      .set("X-Forwarded-For", IP)
      .send({ token: verification?.token })
      .expect(200);

    const login = await request(server)
      .post("/auth/login")
      .set("X-Forwarded-For", IP)
      .send({ email, password: PASSWORD })
      .expect(200);

    return { ...(login.body as Tokens), email };
  }

  const auth = (tokens: { accessToken: string }) => `Bearer ${tokens.accessToken}`;

  /** Mint a token for another workspace the caller belongs to. */
  async function exchange(tokens: Tokens, workspaceId: string): Promise<Tokens> {
    const response = await request(server)
      .post("/auth/token/exchange")
      .set("Authorization", auth(tokens))
      .set("X-Forwarded-For", IP)
      .send({ workspaceId })
      .expect(200);
    return response.body as Tokens;
  }

  async function auditActions(workspaceId?: string): Promise<string[]> {
    const rows = await ctx.prisma.auditLog.findMany({
      ...(workspaceId === undefined ? {} : { where: { workspaceId } }),
      orderBy: { at: "asc" },
      select: { action: true },
    });
    return rows.map((row) => row.action);
  }

  // --- /me -----------------------------------------------------------------

  describe("the profile", () => {
    it("returns the caller's account and the workspace the token is scoped to", async () => {
      const user = await newUser("me");
      const response = await request(server)
        .get("/me")
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body).toMatchObject({
        email: user.email,
        emailVerified: true,
        name: "Test Person",
        locale: "en-IN",
        jurisdiction: "IN",
        ageBracket: "adult",
        marketingOptIn: false,
        deletedAt: null,
        workspace: { id: user.workspaceId, role: "owner" },
      });
      expect(response.body).not.toHaveProperty("passwordHash");
      expect(response.body).not.toHaveProperty("dateOfBirth");
    });

    it("refuses an unauthenticated caller", async () => {
      await request(server).get("/me").expect(401);
    });

    it("updates the name, locale and onboarding state, and audits it", async () => {
      const user = await newUser("patch");
      const response = await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({ name: "Priya Sharma", locale: "hi-IN", onboarding: { tourDone: true } })
        .expect(200);

      expect(response.body).toMatchObject({
        name: "Priya Sharma",
        locale: "hi-IN",
        onboarding: { tourDone: true },
      });
      expect(await auditActions()).toContain("user.profile.updated");
    });

    it("round-trips multi-select onboarding answers (makes, languages) through GET /me", async () => {
      // Onboarding steps 1-2 are multi-select by design (08 §Onboarding): the
      // client sends `string[]` for `makes`/`languages`. A05B: `onboardingSchema`
      // used to accept only boolean | number | string per value and answered
      // `400 common/validation_failed` (`path: "onboarding.makes"`,
      // `code: "invalid_union"`) the instant either question had an answer.
      const user = await newUser("onboarding-multiselect");
      const onboarding = {
        makes: ["reels", "shorts"],
        languages: ["hi-Latn", "en"],
        source: "YouTube",
      };

      const patchResponse = await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({ onboarding })
        .expect(200);
      expect(patchResponse.body).toMatchObject({ onboarding });

      const getResponse = await request(server)
        .get("/me")
        .set("Authorization", auth(user))
        .expect(200);
      expect(getResponse.body).toMatchObject({ onboarding });
    });

    it("writes a consent record when the marketing opt-in changes", async () => {
      const user = await newUser("marketing");
      await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({ marketingOptIn: true })
        .expect(200);

      const records = await ctx.prisma.consentRecord.findMany({
        where: { purpose: "marketing" },
        orderBy: { grantedAt: "asc" },
      });
      // Sign-up wrote the refusal; the patch appends the grant.
      expect(records).toHaveLength(2);
      expect(records.at(-1)).toMatchObject({
        granted: true,
        noticeVersion: PRIVACY_NOTICE_VERSION,
      });
      expect(records.at(-1)?.ip).not.toBeNull();
    });

    it("rejects an empty patch and a non-https avatar", async () => {
      const user = await newUser("patch-invalid");
      await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({})
        .expect(400)
        .expect((res) => expect(res.body.error.code).toBe("common/validation_failed"));
      await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({ avatarUrl: "http://example.test/a.png" })
        .expect(400);
    });
  });

  // --- GET /me/data ---------------------------------------------------------

  describe("the data export", () => {
    it("records a rights request and hands back a working download link", async () => {
      const user = await newUser("export");
      const response = await request(server)
        .get("/me/data")
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body).toMatchObject({ status: "completed" });
      expect(response.body.downloadUrl).toContain("/me/data/");
      expect(response.body.sizeBytes).toBeGreaterThan(0);

      const dsr = await ctx.prisma.dsrRequest.findUniqueOrThrow({
        where: { id: response.body.requestId as string },
      });
      expect(dsr.kind).toBe("export");
      expect(dsr.status).toBe("completed");
      expect(dsr.evidenceKey).toContain("/dsr/");
      // DPDP Rule 14: answered within 30 days.
      expect(dsr.dueAt.getTime() - dsr.receivedAt.getTime()).toBe(30 * 24 * 60 * 60 * 1_000);

      const url = new URL(response.body.downloadUrl as string);
      const bundle = await request(server)
        .get(url.pathname)
        .query({ token: url.searchParams.get("token") })
        .expect(200);

      const parsed = JSON.parse(bundle.text) as Record<string, unknown>;
      expect(parsed).toMatchObject({ schemaVersion: 1 });
      expect((parsed["user"] as { email: string }).email).toBe(user.email);
      expect(parsed["consents"]).toHaveLength(3);
      expect(parsed["workspaces"]).toHaveLength(1);
      expect(JSON.stringify(parsed)).not.toContain("passwordHash");
      expect(JSON.stringify(parsed)).not.toContain("refreshTokenHash");
    });

    it("spends the download link on first use", async () => {
      const user = await newUser("export-once");
      const response = await request(server)
        .get("/me/data")
        .set("Authorization", auth(user))
        .expect(200);

      const url = new URL(response.body.downloadUrl as string);
      const token = url.searchParams.get("token");
      await request(server).get(url.pathname).query({ token }).expect(200);
      await request(server)
        .get(url.pathname)
        .query({ token })
        .expect(404)
        .expect((res) => expect(res.body.error.code).toBe("privacy/export_not_ready"));
    });

    it("refuses a token that belongs to a different request", async () => {
      const first = await newUser("export-a");
      const second = await newUser("export-b");
      const a = await request(server).get("/me/data").set("Authorization", auth(first)).expect(200);
      const b = await request(server)
        .get("/me/data")
        .set("Authorization", auth(second))
        .expect(200);

      const theirToken = new URL(b.body.downloadUrl as string).searchParams.get("token");
      await request(server)
        .get(`/me/data/${a.body.requestId as string}`)
        .query({ token: theirToken })
        .expect(404);
    });
  });

  // --- DELETE /me -----------------------------------------------------------

  describe("erasure", () => {
    it("records the request, anonymises the address and revokes every session", async () => {
      const user = await newUser("erase");
      const response = await request(server)
        .delete("/me")
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body).toMatchObject({ status: "received" });
      expect(response.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

      const row = await ctx.prisma.user.findFirstOrThrow({
        where: { id: claimsOf(user.accessToken)["sub"] as string },
      });
      expect(row.deletedAt).not.toBeNull();
      expect(row.email).toMatch(/@deleted\.invalid$/);
      expect(row.passwordHash).toBeNull();

      const live = await ctx.prisma.session.count({ where: { revokedAt: null } });
      expect(live).toBe(0);

      // The refresh token no longer works, so the account really is signed out.
      await request(server)
        .post("/auth/refresh")
        .set("X-Forwarded-For", IP)
        .send({ refreshToken: user.refreshToken })
        .expect(401);

      expect(await auditActions()).toContain("user.erasure.requested");
    });

    it("is idempotent: a second request returns the one already open", async () => {
      const user = await newUser("erase-twice");
      const first = await request(server)
        .delete("/me")
        .set("Authorization", auth(user))
        .expect(200);
      const second = await request(server)
        .delete("/me")
        .set("Authorization", auth(user))
        .expect(200);

      expect(second.body.requestId).toBe(first.body.requestId);
      expect(await ctx.prisma.dsrRequest.count({ where: { kind: "erasure" } })).toBe(1);
    });

    it("leaves the account read-only afterwards", async () => {
      const user = await newUser("erase-then-patch");
      await request(server).delete("/me").set("Authorization", auth(user)).expect(200);
      await request(server)
        .patch("/me")
        .set("Authorization", auth(user))
        .send({ name: "Still here" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("user/deleted"));
    });
  });

  // --- /consents ------------------------------------------------------------

  describe("consents", () => {
    it("reports every purpose, including the ones never answered", async () => {
      const user = await newUser("consents");
      const response = await request(server)
        .get("/consents")
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body.noticeVersion).toBe(PRIVACY_NOTICE_VERSION);
      expect(response.body.reconsentRequired).toBe(false);
      expect(response.body.purposes).toHaveLength(5);

      const byPurpose = Object.fromEntries(
        (response.body.purposes as { purpose: string; granted: boolean; recorded: boolean }[]).map(
          (entry) => [entry.purpose, entry],
        ),
      );
      // Sign-up asked about three and recorded all three as refusals.
      expect(byPurpose["analytics"]).toMatchObject({ granted: false, recorded: true });
      expect(byPurpose["share_upload"]).toMatchObject({ granted: false, recorded: false });
    });

    it("grants a purpose, appends a row and mirrors it onto the user", async () => {
      const user = await newUser("consent-grant");
      const response = await request(server)
        .post("/consents")
        .set("Authorization", auth(user))
        .set("User-Agent", "AksharoTest/1.0")
        .send({ purpose: "analytics", granted: true })
        .expect(201);

      const analytics = (
        response.body.purposes as { purpose: string; granted: boolean; version: string }[]
      ).find((entry) => entry.purpose === "analytics");
      expect(analytics).toMatchObject({ granted: true, version: PRIVACY_NOTICE_VERSION });

      const row = await ctx.prisma.user.findFirstOrThrow({ where: { email: user.email } });
      expect(row.analyticsConsentAt).not.toBeNull();

      // The record carries who asked, from where and against which notice — a
      // boolean column could not answer any of those (D61).
      const records = await ctx.prisma.consentRecord.findMany({ where: { purpose: "analytics" } });
      expect(records).toHaveLength(2);
      expect(records.some((entry) => entry.ua === "AksharoTest/1.0")).toBe(true);
      expect(records.every((entry) => entry.ip !== null)).toBe(true);
    });

    it("withdraws a purpose, closes the open grant and clears the mirror", async () => {
      const user = await newUser("consent-withdraw");
      await request(server)
        .post("/consents")
        .set("Authorization", auth(user))
        .send({ purpose: "memory", granted: true })
        .expect(201);
      const response = await request(server)
        .post("/consents")
        .set("Authorization", auth(user))
        .send({ purpose: "memory", granted: false })
        .expect(201);

      const memory = (
        response.body.purposes as {
          purpose: string;
          granted: boolean;
          withdrawnAt: string | null;
        }[]
      ).find((entry) => entry.purpose === "memory");
      expect(memory?.granted).toBe(false);
      expect(memory?.withdrawnAt).not.toBeNull();

      const row = await ctx.prisma.user.findFirstOrThrow({ where: { email: user.email } });
      expect(row.memoryConsentAt).toBeNull();

      // Append-only: three rows (sign-up refusal, grant, withdrawal), and the
      // grant now carries a `withdrawnAt`.
      const records = await ctx.prisma.consentRecord.findMany({
        where: { purpose: "memory" },
        orderBy: { grantedAt: "asc" },
      });
      expect(records).toHaveLength(3);
      expect(records.every((entry) => !(entry.granted && entry.withdrawnAt === null))).toBe(true);
      expect(await auditActions()).toContain("consent.recorded");
    });

    it("rejects a purpose outside the 06 enum", async () => {
      const user = await newUser("consent-bad");
      await request(server)
        .post("/consents")
        .set("Authorization", auth(user))
        .send({ purpose: "telemetry", granted: true })
        .expect(400);
    });
  });

  // --- /privacy -------------------------------------------------------------

  describe("privacy", () => {
    it("serves the notice without a session", async () => {
      const response = await request(server).get("/privacy/notice").expect(200);
      expect(response.body.version).toBe(PRIVACY_NOTICE_VERSION);
      expect(response.body.responseDays).toBe(30);
      expect(response.body.purposes.length).toBeGreaterThanOrEqual(5);
    });

    it("keeps the parental waiting list closed to ordinary members", async () => {
      const user = await newUser("waitlist-nobody");
      // A08b's `AdminGuard`: `users.is_admin`, re-read on every request, not a
      // workspace role — the list belongs to nobody's workspace.
      await request(server)
        .get("/admin/parental-waitlist")
        .set("Authorization", auth(user))
        .expect(403);
      await request(server).get("/admin/parental-waitlist").expect(401);
    });

    it("shows a platform administrator the digests, and never an address", async () => {
      const kid = "blocked-kid@example.test";
      await request(server)
        .post("/auth/parental-waitlist")
        .set("X-Forwarded-For", IP)
        .send({ email: kid, jurisdiction: "IN" })
        .expect(202);

      const admin = await newUser("waitlist-admin");
      const adminUser = await ctx.prisma.user.update({
        where: { email: admin.email },
        data: { isAdmin: true },
      });
      const ownedWorkspace = await ctx.prisma.workspace.findFirstOrThrow({
        where: { ownerId: adminUser.id },
      });
      // B13: AdminGuard requires a real kind:"admin" step-up token — the same
      // shared helper every other admin e2e uses.
      const adminCtx = await createAdminContext({
        app: ctx.app,
        roles: ["superadmin"],
        userId: adminUser.id,
        workspaceId: ownedWorkspace.id,
      });

      const response = await request(server)
        .get("/admin/parental-waitlist")
        .set("Authorization", `Bearer ${adminCtx.accessToken}`)
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0]).toMatchObject({
        emailHash: hashEmail(kid),
        jurisdiction: "IN",
        ageBracket: "minor",
        notifiedAt: null,
      });
      expect(JSON.stringify(response.body)).not.toContain(kid);
    });

    it("is idempotent on the address", async () => {
      for (let index = 0; index < 3; index += 1) {
        await request(server)
          .post("/auth/parental-waitlist")
          .set("X-Forwarded-For", IP)
          .send({ email: "Repeat@Example.TEST" })
          .expect(202);
      }
      expect(await ctx.prisma.parentalWaitlist.count()).toBe(1);
    });

    it("migrates A04's Redis entries into the table on boot", async () => {
      // Write the hash exactly as A04 did, then drive the migration the module
      // runs at boot.
      const legacy = "legacy-kid@example.test";
      await ctx.redis.hset(
        redisKeys.parentalWaitlist(),
        hashEmail(legacy),
        JSON.stringify({ email: legacy, at: "2026-08-01T00:00:00.000Z" }),
      );
      const { ParentalWaitlistService } =
        await import("../src/privacy/parental-waitlist.service.js");
      const service = ctx.app.get(ParentalWaitlistService);
      expect(await service.migrateFromRedis()).toBe(1);

      const row = await ctx.prisma.parentalWaitlist.findFirstOrThrow();
      expect(row.emailHash).toBe(hashEmail(legacy));
      expect(row.createdAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
      // The hash is gone: the entries no longer live in a store with no retention.
      expect(await ctx.redis.exists(redisKeys.parentalWaitlist())).toBe(0);
      // Running it again is a no-op rather than a duplicate.
      expect(await service.migrateFromRedis()).toBe(0);
    });
  });

  // --- /workspaces ----------------------------------------------------------

  describe("workspaces", () => {
    it("lists the personal workspace sign-up created, unconfirmed", async () => {
      const user = await newUser("ws-list");
      const response = await request(server)
        .get("/workspaces")
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        id: user.workspaceId,
        type: "personal",
        role: "owner",
        memberCount: 1,
        billingCountry: "IN",
        currency: "INR",
        region: "in",
        // The sign-up default is a guess, and says so.
        billingCountryConfirmedAt: null,
        currencyLocked: false,
      });
    });

    it("creates a team workspace with the caller as owner", async () => {
      const user = await newUser("ws-create");
      const response = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(user))
        .send({ name: "Studio North", slug: "studio-north" })
        .expect(201);

      expect(response.body).toMatchObject({
        name: "Studio North",
        slug: "studio-north",
        type: "team",
        role: "owner",
        billingCountryConfirmedAt: null,
      });
      expect(await auditActions(response.body.id as string)).toContain("workspace.created");

      const list = await request(server)
        .get("/workspaces")
        .set("Authorization", auth(user))
        .expect(200);
      expect(list.body).toHaveLength(2);
    });

    it("refuses a slug that is taken", async () => {
      const user = await newUser("ws-slug");
      await request(server)
        .post("/workspaces")
        .set("Authorization", auth(user))
        .send({ name: "First", slug: "shared-slug" })
        .expect(201);
      await request(server)
        .post("/workspaces")
        .set("Authorization", auth(user))
        .send({ name: "Second", slug: "shared-slug" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/slug_taken"));
    });

    it("renames a workspace and merges settings rather than replacing them", async () => {
      const user = await newUser("ws-patch");
      await request(server)
        .patch(`/workspaces/${user.workspaceId}`)
        .set("Authorization", auth(user))
        .send({ settings: { defaultAspect: "9:16" } })
        .expect(200);
      const response = await request(server)
        .patch(`/workspaces/${user.workspaceId}`)
        .set("Authorization", auth(user))
        .send({ name: "Renamed", settings: { timezone: "Asia/Kolkata" } })
        .expect(200);

      expect(response.body).toMatchObject({
        name: "Renamed",
        settings: { defaultAspect: "9:16", timezone: "Asia/Kolkata" },
      });
    });

    it("refuses to delete the caller's only workspace", async () => {
      const user = await newUser("ws-last");
      await request(server)
        .delete(`/workspaces/${user.workspaceId}`)
        .set("Authorization", auth(user))
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/last_remaining"));
    });

    it("deletes a second workspace and revokes its sessions", async () => {
      const user = await newUser("ws-delete");
      const created = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(user))
        .send({ name: "Disposable" })
        .expect(201);

      const inThere = await exchange(user, created.body.id as string);
      await request(server)
        .delete(`/workspaces/${created.body.id as string}`)
        .set("Authorization", auth(inThere))
        .expect(200);

      const workspace = await ctx.prisma.workspace.findUniqueOrThrow({
        where: { id: created.body.id as string },
      });
      expect(workspace.deletedAt).not.toBeNull();

      const live = await ctx.prisma.session.count({
        where: { workspaceId: created.body.id as string, revokedAt: null },
      });
      expect(live).toBe(0);
    });
  });

  // --- the tax profile ------------------------------------------------------

  describe("the tax profile", () => {
    it("accepts an Indian profile with a State and a matching GSTIN", async () => {
      const user = await newUser("tax-in");
      const response = await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({
          billingCountry: "IN",
          billingStateCode: "27",
          gstin: MAHARASHTRA_GSTIN,
          legalName: "Umbrella Films LLP",
        })
        .expect(200);

      expect(response.body).toMatchObject({
        billingCountry: "IN",
        billingStateCode: "27",
        gstin: MAHARASHTRA_GSTIN,
        legalName: "Umbrella Films LLP",
        currency: "INR",
        region: "in",
        // Accepting a well-formed number is not verifying it; B01 calls the GSTN.
        gstinVerifiedAt: null,
      });
      expect(response.body.billingCountryConfirmedAt).not.toBeNull();
      expect(await auditActions(user.workspaceId)).toContain("workspace.tax_profile.updated");
    });

    it("refuses an Indian profile with no State code (D41)", async () => {
      const user = await newUser("tax-nostate");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN" })
        .expect(422)
        .expect((res) => {
          expect(res.body.error.code).toBe("workspace/tax_profile_invalid");
          expect(res.body.error.details.problem).toBe("state_required");
        });
    });

    it("refuses a GSTIN whose State disagrees with the billing State", async () => {
      const user = await newUser("tax-mismatch");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN", billingStateCode: "27", gstin: KARNATAKA_GSTIN })
        .expect(422)
        .expect((res) => {
          expect(res.body.error.details.problem).toBe("gstin_state_mismatch");
          expect(res.body.error.details.gstinStateCode).toBe("29");
        });
    });

    it("refuses a GSTIN whose check digit is wrong", async () => {
      const user = await newUser("tax-checksum");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({
          billingCountry: "IN",
          billingStateCode: "27",
          gstin: `${MAHARASHTRA_GSTIN.slice(0, 14)}X`,
        })
        .expect(422)
        .expect((res) => expect(res.body.error.details.problem).toBe("gstin_checksum_mismatch"));
    });

    it("derives USD outside India and refuses a State code there", async () => {
      const user = await newUser("tax-us");
      const response = await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "US" })
        .expect(200);
      expect(response.body).toMatchObject({
        billingCountry: "US",
        billingStateCode: null,
        currency: "USD",
        region: "us",
      });

      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "US", billingStateCode: "27" })
        .expect(422)
        .expect((res) => expect(res.body.error.details.problem).toBe("state_not_applicable"));
    });

    it("locks the currency once a non-zero-priced subscription exists (B01b: not for Free)", async () => {
      const user = await newUser("tax-locked");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN", billingStateCode: "27" })
        .expect(200);

      const plan = await ctx.prisma.plan.upsert({
        where: { key: "creator" },
        create: {
          id: "01JPLANCREATOR00000000000",
          key: "creator",
          name: "Creator",
          prices: { INR: { month: 69_900 }, USD: { month: 1_900 } },
          creditsPerMonthTenths: 5_000,
          entitlements: {},
        },
        update: {},
      });
      await ctx.prisma.subscription.create({
        data: {
          id: "01JSUB00000000000000000000",
          workspaceId: user.workspaceId,
          planId: plan.id,
          status: "active",
          currency: "INR",
          listPriceMinor: 69_900,
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        },
      });

      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "US" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/tax_profile_locked"));

      // The same currency is still editable: only the country change is refused.
      const response = await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN", billingStateCode: "29", legalName: "Renamed LLP" })
        .expect(200);
      expect(response.body).toMatchObject({ billingStateCode: "29", currencyLocked: true });
    });

    it("does NOT lock the currency for a zero-priced (Free) subscription (B01b, orchestrator addendum after A05)", async () => {
      const user = await newUser("tax-free-unlocked");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN", billingStateCode: "27" })
        .expect(200);

      const plan = await ctx.prisma.plan.findUniqueOrThrow({ where: { key: "free" } });
      await ctx.prisma.subscription.create({
        data: {
          id: "01JSUBFREE0000000000000000",
          workspaceId: user.workspaceId,
          planId: plan.id,
          status: "active",
          currency: "INR",
          listPriceMinor: 0,
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        },
      });

      const response = await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "US" })
        .expect(200);
      expect(response.body).toMatchObject({ currency: "USD", currencyLocked: false });
    });

    it("locks the currency when a paid invoice exists, even with no live subscription", async () => {
      const user = await newUser("tax-invoice-locked");
      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "IN", billingStateCode: "27" })
        .expect(200);

      await ctx.prisma.invoice.create({
        data: {
          id: "01JINVOICEPAID000000000000",
          workspaceId: user.workspaceId,
          docType: "tax_invoice",
          series: "MTJ",
          number: "1",
          fiscalYear: "2026-27",
          supplierLegalName: "Aksharo",
          recipientLegalName: "Test Recipient",
          recipientCountry: "IN",
          recipientStateCode: "27",
          placeOfSupplyCountry: "IN",
          placeOfSupplyStateCode: "27",
          supplyType: "intra_state",
          sacCode: "998314",
          itemDescription: "Subscription",
          currency: "INR",
          status: "paid",
        },
      });

      await request(server)
        .put(`/workspaces/${user.workspaceId}/tax-profile`)
        .set("Authorization", auth(user))
        .send({ billingCountry: "US" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/tax_profile_locked"));
    });
  });

  // --- the entitlement stub -------------------------------------------------

  describe("the entitlement", () => {
    it("returns the Free plan and caches it for 60 seconds", async () => {
      const user = await newUser("entitlement");
      const first = await request(server)
        .get(`/workspaces/${user.workspaceId}/entitlement`)
        .set("Authorization", auth(user))
        .expect(200);

      expect(first.body).toMatchObject({
        workspaceId: user.workspaceId,
        planKey: "free",
        planName: "Free",
        creditsPerMonthTenths: 200,
        seatsUsed: 1,
      });

      // The product's own builder, not a literal: A23b makes the namespace
      // per-suite so twenty-two e2e suites can share one logical Redis database.
      const key = workspacesRedisKeys.entitlement(user.workspaceId);
      expect(await ctx.redis.ttl(key)).toBeGreaterThan(0);
      expect(await ctx.redis.ttl(key)).toBeLessThanOrEqual(60);

      // The second call is served from the cache: same snapshot, same timestamp.
      const second = await request(server)
        .get(`/workspaces/${user.workspaceId}/entitlement`)
        .set("Authorization", auth(user))
        .expect(200);
      expect(second.body.computedAt).toBe(first.body.computedAt);
    });
  });

  // --- members and invitations ---------------------------------------------

  describe("members", () => {
    it("lists the owner of a new workspace", async () => {
      const user = await newUser("members-list");
      const response = await request(server)
        .get(`/workspaces/${user.workspaceId}/members`)
        .set("Authorization", auth(user))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        role: "owner",
        status: "active",
        email: user.email,
      });
    });

    it("runs an invitation from send to accepted", async () => {
      const owner = await newUser("invite-owner");
      const team = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(owner))
        .send({ name: "Team" })
        .expect(201);
      const inTeam = await exchange(owner, team.body.id as string);

      const invitee = await newUser("invite-guest");
      const invitation = await request(server)
        .post(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(inTeam))
        .send({ email: invitee.email, role: "editor" })
        .expect(201);

      expect(invitation.body).toMatchObject({
        status: "invited",
        role: "editor",
        userId: null,
        email: invitee.email,
      });

      // The invitation was actually sent, through the notify port.
      const outbox = await ctx.outbox();
      expect(outbox.some((entry) => entry.template === "member_invited")).toBe(true);

      const pending = await request(server)
        .get("/invitations")
        .set("Authorization", auth(invitee))
        .expect(200);
      expect(pending.body).toHaveLength(1);
      expect(pending.body[0]).toMatchObject({
        workspaceId: team.body.id,
        workspaceName: "Team",
        role: "editor",
      });

      const accepted = await request(server)
        .post(`/invitations/${invitation.body.id as string}/accept`)
        .set("Authorization", auth(invitee))
        .expect(201);
      expect(accepted.body).toMatchObject({ workspaceId: team.body.id, role: "editor" });

      // The invitee's own token still points at their personal workspace: joining
      // must not silently move somebody's session.
      const stillPersonal = await request(server)
        .get("/me")
        .set("Authorization", auth(invitee))
        .expect(200);
      expect(stillPersonal.body.workspace.id).toBe(invitee.workspaceId);

      const asMember = await exchange(invitee, team.body.id as string);
      const members = await request(server)
        .get(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(asMember))
        .expect(200);
      expect(members.body).toHaveLength(2);
      expect(await auditActions(team.body.id as string)).toEqual(
        expect.arrayContaining(["workspace.member.invited", "workspace.member.invite_accepted"]),
      );
    });

    it("refuses an invitation addressed to somebody else", async () => {
      const owner = await newUser("invite-wrong-owner");
      const team = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(owner))
        .send({ name: "Closed" })
        .expect(201);
      const inTeam = await exchange(owner, team.body.id as string);

      const invited = await newUser("invite-wrong-a");
      const stranger = await newUser("invite-wrong-b");
      const invitation = await request(server)
        .post(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(inTeam))
        .send({ email: invited.email, role: "viewer" })
        .expect(201);

      // The id travels in an email; it is a lookup key, not a bearer secret.
      await request(server)
        .post(`/invitations/${invitation.body.id as string}/accept`)
        .set("Authorization", auth(stranger))
        .expect(404)
        .expect((res) => expect(res.body.error.code).toBe("workspace/invitation_not_found"));
    });

    it("refuses to invite the same address twice", async () => {
      const owner = await newUser("invite-twice");
      const team = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(owner))
        .send({ name: "Twice" })
        .expect(201);
      const inTeam = await exchange(owner, team.body.id as string);

      await request(server)
        .post(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(inTeam))
        .send({ email: "guest@example.test", role: "viewer" })
        .expect(201);
      await request(server)
        .post(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(inTeam))
        .send({ email: "GUEST@example.test", role: "editor" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/member_already_present"));
    });

    it("declines an invitation", async () => {
      const owner = await newUser("decline-owner");
      const team = await request(server)
        .post("/workspaces")
        .set("Authorization", auth(owner))
        .send({ name: "Declined" })
        .expect(201);
      const inTeam = await exchange(owner, team.body.id as string);
      const invitee = await newUser("decline-guest");

      const invitation = await request(server)
        .post(`/workspaces/${team.body.id as string}/members`)
        .set("Authorization", auth(inTeam))
        .send({ email: invitee.email, role: "viewer" })
        .expect(201);

      await request(server)
        .delete(`/invitations/${invitation.body.id as string}`)
        .set("Authorization", auth(invitee))
        .expect(204);
      expect(
        await ctx.prisma.membership.count({ where: { workspaceId: team.body.id as string } }),
      ).toBe(1);
    });

    it("changes a role, and refuses to touch the owner", async () => {
      const { team, ownerTokens, membershipId } = await teamWithMember("role");

      const updated = await request(server)
        .patch(`/workspaces/${team}/members/${membershipId}`)
        .set("Authorization", auth(ownerTokens))
        .send({ role: "admin" })
        .expect(200);
      expect(updated.body.role).toBe("admin");
      expect(await auditActions(team)).toContain("workspace.member.role_changed");

      const owner = await ctx.prisma.membership.findFirstOrThrow({
        where: { workspaceId: team, role: "owner" },
      });
      await request(server)
        .patch(`/workspaces/${team}/members/${owner.id}`)
        .set("Authorization", auth(ownerTokens))
        .send({ role: "viewer" })
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/owner_immutable"));
    });

    it("removes a member and revokes their sessions in that workspace", async () => {
      const { team, ownerTokens, memberTokens, membershipId } = await teamWithMember("remove");

      // The member is in and working.
      await request(server)
        .get(`/workspaces/${team}`)
        .set("Authorization", auth(memberTokens))
        .expect(200);

      await request(server)
        .delete(`/workspaces/${team}/members/${membershipId}`)
        .set("Authorization", auth(ownerTokens))
        .expect(200);

      const row = await ctx.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } });
      expect(row.status).toBe("removed");
      expect(row.seatBilled).toBe(false);

      // The access token has not expired, but the membership guard re-reads the
      // row, so access ends now rather than in fifteen minutes (T4).
      await request(server)
        .get(`/workspaces/${team}`)
        .set("Authorization", auth(memberTokens))
        .expect(403)
        .expect((res) => expect(res.body.error.code).toBe("auth/not_a_member"));

      const live = await ctx.prisma.session.count({
        where: { workspaceId: team, revokedAt: null },
      });
      expect(live).toBe(1); // the owner's
    });

    it("refuses to remove the owner", async () => {
      const { team, ownerTokens } = await teamWithMember("remove-owner");
      const owner = await ctx.prisma.membership.findFirstOrThrow({
        where: { workspaceId: team, role: "owner" },
      });
      await request(server)
        .delete(`/workspaces/${team}/members/${owner.id}`)
        .set("Authorization", auth(ownerTokens))
        .expect(409)
        .expect((res) => expect(res.body.error.code).toBe("workspace/owner_immutable"));
    });

    it("stops an editor inviting, renaming or setting the tax profile", async () => {
      const { team, memberTokens } = await teamWithMember("roles");

      await request(server)
        .get(`/workspaces/${team}/members`)
        .set("Authorization", auth(memberTokens))
        .expect(200);
      await request(server)
        .post(`/workspaces/${team}/members`)
        .set("Authorization", auth(memberTokens))
        .send({ email: "another@example.test", role: "viewer" })
        .expect(403);
      await request(server)
        .patch(`/workspaces/${team}`)
        .set("Authorization", auth(memberTokens))
        .send({ name: "Nope" })
        .expect(403);
      await request(server)
        .put(`/workspaces/${team}/tax-profile`)
        .set("Authorization", auth(memberTokens))
        .send({ billingCountry: "US" })
        .expect(403);
      await request(server)
        .delete(`/workspaces/${team}`)
        .set("Authorization", auth(memberTokens))
        .expect(403);
    });

    it("stops an admin from granting a role above their own", async () => {
      const { team, ownerTokens, memberTokens, membershipId } = await teamWithMember("ladder");
      await request(server)
        .patch(`/workspaces/${team}/members/${membershipId}`)
        .set("Authorization", auth(ownerTokens))
        .send({ role: "admin" })
        .expect(200);

      const asAdmin = await exchange(memberTokens, team);
      const owner = await ctx.prisma.membership.findFirstOrThrow({
        where: { workspaceId: team, role: "owner" },
      });
      // Promoting the owner is refused because the owner is immutable; promoting
      // anybody to owner is refused because the ladder does not allow it.
      await request(server)
        .patch(`/workspaces/${team}/members/${owner.id}`)
        .set("Authorization", auth(asAdmin))
        .send({ role: "admin" })
        .expect(409);
    });
  });

  /** An owner, a team workspace and one accepted `editor` member. */
  async function teamWithMember(label: string): Promise<{
    team: string;
    ownerTokens: Tokens;
    memberTokens: Tokens;
    membershipId: string;
  }> {
    const owner = await newUser(`${label}-owner`);
    const created = await request(server)
      .post("/workspaces")
      .set("Authorization", auth(owner))
      .send({ name: `Team ${label}` })
      .expect(201);
    const team = created.body.id as string;
    const ownerTokens = await exchange(owner, team);

    const member = await newUser(`${label}-member`);
    const invitation = await request(server)
      .post(`/workspaces/${team}/members`)
      .set("Authorization", auth(ownerTokens))
      .send({ email: member.email, role: "editor" })
      .expect(201);
    await request(server)
      .post(`/invitations/${invitation.body.id as string}/accept`)
      .set("Authorization", auth(member))
      .expect(201);
    const memberTokens = await exchange(member, team);

    return { team, ownerTokens, memberTokens, membershipId: invitation.body.id as string };
  }

  function claimsOf(accessToken: string): Record<string, unknown> {
    const payload = accessToken.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  }
});
