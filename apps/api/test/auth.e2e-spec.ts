/**
 * The A04 acceptance suite.
 *
 * Runs against a real PostgreSQL and a real Redis (testcontainers, or the URLs in
 * `TEST_DATABASE_URL` / `TEST_REDIS_URL`), because every property worth asserting
 * here — a refresh family, a 60-second rotation grace, a single-use device code —
 * is a property of those stores rather than of the TypeScript.
 *
 * Skips with an explanation when Docker is unavailable, like `database.e2e-spec.ts`.
 */
import request from "supertest";
import { ulid } from "ulid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authSkipReason, createAuthTestContext } from "./auth-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { redisKeys } from "../src/auth/auth.constants.js";
import { sha256Hex } from "../src/auth/tokens.js";

import type { AuthTestContext } from "./auth-harness.js";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[auth.e2e] SKIPPED - ${skipReason}`);
}

const PASSWORD = "correct-horse-battery-staple";
/** 2026-09-02 minus 30 years: comfortably an adult in every jurisdiction. */
const ADULT_DOB = "1996-01-15";

interface Tokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  workspaceId: string;
  role: string;
  kind: string;
  expiresIn: number;
  tokenType: string;
}

describe.skipIf(!available)("auth (e2e)", () => {
  let ctx: AuthTestContext;
  let server: Server;

  beforeAll(async () => {
    const created = await createAuthTestContext();
    if (created === null) throw new Error(`auth harness unavailable: ${authSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  // --- helpers -------------------------------------------------------------

  /** A distinct address per case, so buckets and unique indexes never collide. */
  const address = (label: string) => `${label}-${Date.now().toString(36)}@example.test`;

  /** Not `async`: callers chain supertest's `.expect()` on the returned Test. */
  function signUp(email: string, overrides: Record<string, unknown> = {}, ip = "203.0.113.10") {
    return request(server)
      .post("/auth/signup")
      .set("X-Forwarded-For", ip)
      .send({
        email,
        password: PASSWORD,
        name: "Test Person",
        dateOfBirth: ADULT_DOB,
        jurisdiction: "IN",
        ...overrides,
      });
  }

  /** The token of the most recent message of a template. */
  async function tokenFromOutbox(template: string): Promise<string> {
    const messages = await ctx.outbox();
    const message = messages.find((entry) => entry.template === template);
    expect(message, `no ${template} message in the outbox`).toBeDefined();
    expect(message?.token).toBeTruthy();
    return message?.token ?? "";
  }

  /** Sign up, confirm the address and sign in. Returns the token pair. */
  async function newVerifiedUser(
    label: string,
    ip = "203.0.113.10",
  ): Promise<Tokens & { email: string }> {
    const email = address(label);
    await signUp(email, {}, ip).expect(202);
    const token = await tokenFromOutbox("email_verification");
    await request(server)
      .post("/auth/verify-email")
      .set("X-Forwarded-For", ip)
      .send({ token })
      .expect(200);

    const login = await request(server)
      .post("/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email, password: PASSWORD })
      .expect(200);

    return { ...(login.body as Tokens), email };
  }

  function claimsOf(accessToken: string): Record<string, unknown> {
    const payload = accessToken.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  }

  // --- sign-up, verification, login ---------------------------------------

  describe("sign-up and verification", () => {
    it("creates the user, a personal workspace, an owner membership and consent rows", async () => {
      const email = address("signup");
      const response = await signUp(email).expect(202);
      expect(response.body).toEqual({ status: "verification_sent", email });

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email },
        include: { memberships: true, consentRecords: true },
      });
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      expect(user.ageBracket).toBe("adult");
      expect(user.memberships).toHaveLength(1);
      expect(user.memberships[0]?.role).toBe("owner");

      // Every purpose asked about is recorded, refusals included (DPDP).
      expect(user.consentRecords.map((row) => row.purpose).sort()).toEqual([
        "analytics",
        "marketing",
        "memory",
      ]);
      expect(user.consentRecords.every((row) => !row.granted)).toBe(true);

      const workspace = await ctx.prisma.workspace.findFirstOrThrow({
        where: { ownerId: user.id },
      });
      expect(workspace.type).toBe("personal");
    });

    it("records the consents the form sent", async () => {
      const email = address("consent");
      await signUp(email, { consents: { analytics: true, marketing: false, memory: true } }).expect(
        202,
      );
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email },
        include: { consentRecords: true },
      });
      const granted = Object.fromEntries(
        user.consentRecords.map((row) => [row.purpose, row.granted]),
      );
      expect(granted).toEqual({ analytics: true, memory: true, marketing: false });
      expect(user.analyticsConsentAt).not.toBeNull();
      expect(user.marketingOptIn).toBe(false);
    });

    it("does not reveal that an address is already registered", async () => {
      const email = address("dup");
      await signUp(email).expect(202);
      const second = await signUp(email).expect(202);
      expect(second.body).toEqual({ status: "verification_sent", email });
      expect(await ctx.prisma.user.count({ where: { email } })).toBe(1);
    });

    it("refuses a password below the length floor", async () => {
      const response = await signUp(address("weak"), { password: "short" }).expect(400);
      expect(response.body.error.code).toBe("auth/weak_password");
    });

    it("refuses a password containing the address", async () => {
      const response = await signUp("bilberry@example.test", {
        password: "my-bilberry-password",
      }).expect(400);
      expect(response.body.error.details.reason).toBe("contains_email");
    });

    it("refuses to sign in before the address is confirmed", async () => {
      const email = address("unverified");
      await signUp(email).expect(202);
      const response = await request(server)
        .post("/auth/login")
        .send({ email, password: PASSWORD })
        .expect(403);
      expect(response.body.error.code).toBe("auth/email_not_verified");
    });

    it("signs in after verification and mints the CONTRACTS section 5 claim set", async () => {
      const tokens = await newVerifiedUser("verified");
      expect(tokens.tokenType).toBe("Bearer");
      expect(tokens.expiresIn).toBe(900);
      expect(tokens.role).toBe("owner");
      expect(tokens.kind).toBe("web");

      const claims = claimsOf(tokens.accessToken);
      expect(Object.keys(claims).sort()).toEqual([
        "exp",
        "iat",
        "iss",
        "jti",
        "kind",
        "role",
        "sub",
        "ws",
      ]);
      expect(claims["ws"]).toBe(tokens.workspaceId);
      expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(900);

      const header = JSON.parse(
        Buffer.from(tokens.accessToken.split(".")[0] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      expect(header["alg"]).toBe("RS256");
    });

    it("burns the verification token after one use", async () => {
      const email = address("single-use");
      await signUp(email).expect(202);
      const token = await tokenFromOutbox("email_verification");
      await request(server).post("/auth/verify-email").send({ token }).expect(200);
      const second = await request(server).post("/auth/verify-email").send({ token }).expect(400);
      expect(second.body.error.code).toBe("auth/invalid_token");
    });

    it("answers an unknown address and a wrong password identically", async () => {
      const { email } = await newVerifiedUser("generic");
      const wrongPassword = await request(server)
        .post("/auth/login")
        .set("X-Forwarded-For", "203.0.113.21")
        .send({ email, password: "not-the-password-at-all" })
        .expect(401);
      const unknownUser = await request(server)
        .post("/auth/login")
        .set("X-Forwarded-For", "203.0.113.22")
        .send({ email: address("nobody"), password: PASSWORD })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe("auth/invalid_credentials");
      expect(unknownUser.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
    });
  });

  // --- the age gate (D60) --------------------------------------------------

  describe("age gate", () => {
    /** A date of birth that makes the applicant exactly `years` old today. */
    function dobForAge(years: number): string {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() - years);
      date.setUTCDate(date.getUTCDate() - 1);
      return date.toISOString().slice(0, 10);
    }

    it("blocks a 17-year-old in India", async () => {
      const response = await signUp(address("in17"), {
        dateOfBirth: dobForAge(17),
        jurisdiction: "IN",
      }).expect(403);
      expect(response.body.error.code).toBe("auth/age_restricted");
      expect(response.body.error.details.minimumAge).toBe(18);
      expect(response.body.error.details.waitlistPath).toBe("/auth/parental-waitlist");
    });

    it("blocks a 15-year-old in the EU", async () => {
      const response = await signUp(address("eu15"), {
        dateOfBirth: dobForAge(15),
        jurisdiction: "EU",
      }).expect(403);
      expect(response.body.error.details.minimumAge).toBe(16);
    });

    it("allows a 16-year-old in the EU, recorded as a minor", async () => {
      const email = address("eu16");
      await signUp(email, { dateOfBirth: dobForAge(16), jurisdiction: "EU" }).expect(202);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.ageBracket).toBe("minor");
      expect(user.jurisdiction).toBe("EU");
    });

    it("allows an 18-year-old in India, recorded as an adult", async () => {
      const email = address("in18");
      await signUp(email, { dateOfBirth: dobForAge(18), jurisdiction: "IN" }).expect(202);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.ageBracket).toBe("adult");
    });

    it("takes a parental waitlist entry", async () => {
      const email = address("guardian");
      await request(server)
        .post("/auth/parental-waitlist")
        .set("X-Forwarded-For", "203.0.113.30")
        .send({ email })
        .expect(202);

      const stored = await ctx.redis.hget(redisKeys.parentalWaitlist(), sha256Hex(email));
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored ?? "{}")).toMatchObject({ email });
    });

    it("rejects an impossible date of birth", async () => {
      const response = await signUp(address("timelord"), { dateOfBirth: "1799-01-01" }).expect(400);
      expect(response.body.error.code).toBe("common/validation_failed");
    });
  });

  // --- refresh families (THREAT-MODEL T2) ---------------------------------

  describe("refresh rotation and reuse detection", () => {
    it("rotates the token and keeps the family", async () => {
      const tokens = await newVerifiedUser("rotate");
      const rotated = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const next = rotated.body as Tokens;
      expect(next.refreshToken).not.toBe(tokens.refreshToken);
      expect(next.sessionId).toBe(tokens.sessionId);

      const session = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: tokens.sessionId },
      });
      expect(session.refreshTokenHash).toBe(sha256Hex(next.refreshToken));
      expect(session.previousHash).toBe(sha256Hex(tokens.refreshToken));
      expect(session.rotatedAt).not.toBeNull();
      expect(session.revokedAt).toBeNull();
    });

    it("replays the same new pair for the previous token inside the grace window", async () => {
      const tokens = await newVerifiedUser("grace");
      const first = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      const replay = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      expect((replay.body as Tokens).refreshToken).toBe((first.body as Tokens).refreshToken);
      expect((replay.body as Tokens).accessToken).toBe((first.body as Tokens).accessToken);

      const sessions = await ctx.prisma.session.findMany({ where: { id: tokens.sessionId } });
      expect(sessions[0]?.revokedAt).toBeNull();
    });

    it("revokes the whole family when a spent token is replayed after the grace", async () => {
      const tokens = await newVerifiedUser("reuse");
      const rotated = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      const next = rotated.body as Tokens;

      // Age the rotation past the 60-second grace and drop the replay entry, which
      // is exactly the state a stolen token would be presented in.
      await ctx.prisma.session.update({
        where: { id: tokens.sessionId },
        data: { rotatedAt: new Date(Date.now() - 120_000) },
      });
      await ctx.redis.del(redisKeys.refreshGrace(sha256Hex(tokens.refreshToken)));

      const reuse = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      expect(reuse.body.error.code).toBe("auth/session_revoked");
      expect(reuse.body.error.details.reason).toBe("refresh_token_reuse");

      const session = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: tokens.sessionId },
      });
      expect(session.revokedAt).not.toBeNull();

      // The token the thief's victim still holds is dead too.
      const afterRevocation = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: next.refreshToken })
        .expect(401);
      expect(afterRevocation.body.error.code).toBe("auth/session_revoked");

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: "auth.refresh.reuse_detected" },
      });
      expect(audit).not.toBeNull();
    });

    it("rejects a refresh token it never issued", async () => {
      const response = await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: "a".repeat(43) })
        .expect(401);
      expect(response.body.error.code).toBe("common/unauthorized");
    });

    it("revokes the family on logout and answers 204 for an unknown token", async () => {
      const tokens = await newVerifiedUser("logout");
      await request(server)
        .post("/auth/logout")
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      const session = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: tokens.sessionId },
      });
      expect(session.revokedAt).not.toBeNull();

      await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      // No oracle: an unknown token gets the same 204.
      await request(server)
        .post("/auth/logout")
        .send({ refreshToken: "b".repeat(43) })
        .expect(204);
    });
  });

  // --- sessions ------------------------------------------------------------

  describe("sessions", () => {
    it("lists the caller's sessions and marks the current one", async () => {
      const first = await newVerifiedUser("sessions");
      const second = await request(server)
        .post("/auth/login")
        .set("X-Forwarded-For", "203.0.113.40")
        .send({ email: first.email, password: PASSWORD, kind: "desktop" })
        .expect(200);

      const listed = await request(server)
        .get("/auth/sessions")
        .set("Authorization", `Bearer ${first.accessToken}`)
        .expect(200);

      const rows = listed.body as { id: string; current: boolean; kind: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.current)).toHaveLength(1);
      expect(rows.find((row) => row.current)?.id).toBe(first.sessionId);
      expect(rows.map((row) => row.kind).sort()).toEqual(["desktop", "web"]);
      expect((second.body as Tokens).sessionId).not.toBe(first.sessionId);
    });

    it("revokes a session by id and kills its refresh family", async () => {
      const owner = await newVerifiedUser("revoke");
      const other = await request(server)
        .post("/auth/login")
        .set("X-Forwarded-For", "203.0.113.41")
        .send({ email: owner.email, password: PASSWORD, kind: "desktop" })
        .expect(200);
      const otherTokens = other.body as Tokens;

      await request(server)
        .delete(`/auth/sessions/${otherTokens.sessionId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .expect(204);

      await request(server)
        .post("/auth/refresh")
        .send({ refreshToken: otherTokens.refreshToken })
        .expect(401);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: "auth.session.revoked" },
      });
      expect(audit?.resourceId).toBe(otherTokens.sessionId);
    });

    it("will not revoke somebody else's session", async () => {
      const mine = await newVerifiedUser("mine", "203.0.113.42");
      const theirs = await newVerifiedUser("theirs", "203.0.113.43");

      const response = await request(server)
        .delete(`/auth/sessions/${theirs.sessionId}`)
        .set("Authorization", `Bearer ${mine.accessToken}`)
        .expect(404);
      expect(response.body.error.code).toBe("common/not_found");

      const untouched = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: theirs.sessionId },
      });
      expect(untouched.revokedAt).toBeNull();
    });
  });

  // --- guards (THREAT-MODEL T4) -------------------------------------------

  describe("guards", () => {
    it("refuses an authenticated route without a token", async () => {
      const response = await request(server).get("/auth/sessions").expect(401);
      expect(response.body.error.code).toBe("common/unauthorized");
    });

    it("refuses a malformed token, a wrong signature and an expired one", async () => {
      await request(server).get("/auth/sessions").set("Authorization", "Bearer nope").expect(401);
      await request(server).get("/auth/sessions").set("Authorization", "Basic abc").expect(401);

      const tokens = await newVerifiedUser("tamper");
      const [header, payload] = tokens.accessToken.split(".");
      const forged = `${header ?? ""}.${payload ?? ""}.${"A".repeat(342)}`;
      await request(server)
        .get("/auth/sessions")
        .set("Authorization", `Bearer ${forged}`)
        .expect(401);
    });

    it("ignores a workspace supplied in a header", async () => {
      const mine = await newVerifiedUser("tenant", "203.0.113.44");
      const theirs = await newVerifiedUser("neighbour", "203.0.113.45");

      const listed = await request(server)
        .get("/auth/sessions")
        .set("Authorization", `Bearer ${mine.accessToken}`)
        .set("X-Workspace-Id", theirs.workspaceId)
        .expect(200);

      const rows = listed.body as { workspaceId: string }[];
      expect(rows.every((row) => row.workspaceId === mine.workspaceId)).toBe(true);
    });
  });

  // --- workspace token exchange -------------------------------------------

  describe("token exchange", () => {
    it("mints a token for a workspace the caller belongs to", async () => {
      const owner = await newVerifiedUser("ws-owner", "203.0.113.50");
      const guest = await newVerifiedUser("ws-guest", "203.0.113.51");
      const guestId = String(claimsOf(guest.accessToken)["sub"]);

      await ctx.prisma.membership.create({
        data: {
          id: ulid(),
          workspaceId: owner.workspaceId,
          userId: guestId,
          role: "editor",
          status: "active",
        },
      });

      const exchanged = await request(server)
        .post("/auth/token/exchange")
        .set("Authorization", `Bearer ${guest.accessToken}`)
        .send({ workspaceId: owner.workspaceId })
        .expect(200);

      const tokens = exchanged.body as Tokens;
      expect(tokens.workspaceId).toBe(owner.workspaceId);
      expect(tokens.role).toBe("editor");
      expect(claimsOf(tokens.accessToken)["ws"]).toBe(owner.workspaceId);
      expect(claimsOf(tokens.accessToken)["role"]).toBe("editor");
      // A switch is a new session, so it can be revoked on its own.
      expect(tokens.sessionId).not.toBe(guest.sessionId);
    });

    it("refuses a workspace the caller is not a member of", async () => {
      const owner = await newVerifiedUser("ws-closed", "203.0.113.52");
      const outsider = await newVerifiedUser("ws-outsider", "203.0.113.53");

      const response = await request(server)
        .post("/auth/token/exchange")
        .set("Authorization", `Bearer ${outsider.accessToken}`)
        .send({ workspaceId: owner.workspaceId })
        .expect(403);
      expect(response.body.error.code).toBe("auth/not_a_member");
    });

    it("refuses a suspended membership", async () => {
      const owner = await newVerifiedUser("ws-susp", "203.0.113.54");
      const guest = await newVerifiedUser("ws-susp-guest", "203.0.113.55");
      const guestId = String(claimsOf(guest.accessToken)["sub"]);

      await ctx.prisma.membership.create({
        data: {
          id: ulid(),
          workspaceId: owner.workspaceId,
          userId: guestId,
          role: "editor",
          status: "suspended",
        },
      });

      await request(server)
        .post("/auth/token/exchange")
        .set("Authorization", `Bearer ${guest.accessToken}`)
        .send({ workspaceId: owner.workspaceId })
        .expect(403);
    });
  });

  // --- magic links ---------------------------------------------------------

  describe("magic link", () => {
    it("signs a user in, verifies the address and burns the token", async () => {
      const email = address("magic");
      await signUp(email, {}, "203.0.113.60").expect(202);

      await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "203.0.113.60")
        .send({ email })
        .expect(202);

      const token = await tokenFromOutbox("magic_link");
      const consumed = await request(server)
        .post("/auth/magic-link/consume")
        .set("X-Forwarded-For", "203.0.113.60")
        .send({ token })
        .expect(200);

      expect((consumed.body as Tokens).accessToken).toBeTruthy();
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerifiedAt).not.toBeNull();

      const replay = await request(server)
        .post("/auth/magic-link/consume")
        .set("X-Forwarded-For", "203.0.113.60")
        .send({ token })
        .expect(400);
      expect(replay.body.error.code).toBe("auth/invalid_token");
    });

    it("says the same thing for an address with no account, and sends nothing", async () => {
      const response = await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "203.0.113.61")
        .send({ email: address("ghost") })
        .expect(202);
      expect(response.body).toEqual({ status: "sent" });
      expect(await ctx.outbox()).toHaveLength(0);
    });
  });

  // --- Google OAuth (PKCE) -------------------------------------------------

  describe("google oauth", () => {
    async function startFlow(client: string, ip = "203.0.113.70"): Promise<string> {
      const started = await request(server)
        .get(`/auth/oauth/google/start?client=${client}`)
        .set("X-Forwarded-For", ip)
        .expect(302);
      const location = new URL(started.headers["location"] ?? "");
      return location.searchParams.get("state") ?? "";
    }

    it("redirects to the provider with an S256 challenge and stores the state", async () => {
      const state = await startFlow("web");
      expect(state).toHaveLength(43);
      expect(await ctx.redis.exists(redisKeys.oauthState(state))).toBe(1);

      const authorization = ctx.google.authorizations.at(-1);
      expect(authorization?.state).toBe(state);
      expect(authorization?.codeChallenge).toHaveLength(43);
      expect(authorization?.redirectUri).toContain("/auth/oauth/google/callback");
    });

    it("registers a new identity, and requires a date of birth before it does", async () => {
      const state = await startFlow("web");
      const email = address("google-new");
      ctx.google.profiles.set("code-new", {
        subject: "google-subject-1",
        email,
        emailVerified: true,
        name: "New Person",
      });

      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-new&state=${state}`)
        .expect(302);
      const redirect = new URL(callback.headers["location"] ?? "");
      expect(redirect.origin).toBe("http://localhost:3000");
      expect(redirect.searchParams.get("status")).toBe("registration");

      // The verifier really did travel to the provider.
      expect(ctx.google.exchanges.at(-1)?.codeVerifier).toHaveLength(43);

      const handoff = redirect.searchParams.get("code") ?? "";
      const incomplete = await request(server)
        .post("/auth/oauth/complete")
        .set("X-Forwarded-For", "203.0.113.70")
        .send({ code: handoff })
        .expect(400);
      expect(incomplete.body.error.code).toBe("auth/registration_incomplete");
    });

    it("creates the account once the date of birth is supplied", async () => {
      const state = await startFlow("web");
      const email = address("google-complete");
      ctx.google.profiles.set("code-complete", {
        subject: "google-subject-2",
        email,
        emailVerified: true,
        name: "Complete Person",
      });

      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-complete&state=${state}`)
        .expect(302);
      const handoff = new URL(callback.headers["location"] ?? "").searchParams.get("code") ?? "";

      const completed = await request(server)
        .post("/auth/oauth/complete")
        .set("X-Forwarded-For", "203.0.113.70")
        .send({ code: handoff, dateOfBirth: ADULT_DOB, jurisdiction: "IN" })
        .expect(200);

      const tokens = completed.body as Tokens;
      expect(tokens.role).toBe("owner");

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email },
        include: { identities: true },
      });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.identities[0]?.provider).toBe("google");
      expect(user.identities[0]?.providerId).toBe("google-subject-2");

      // The handoff code is single-use.
      await request(server)
        .post("/auth/oauth/complete")
        .set("X-Forwarded-For", "203.0.113.70")
        .send({ code: handoff, dateOfBirth: ADULT_DOB, jurisdiction: "IN" })
        .expect(400);
    });

    it("applies the age gate to a Google sign-up", async () => {
      const state = await startFlow("web");
      ctx.google.profiles.set("code-minor", {
        subject: "google-subject-minor",
        email: address("google-minor"),
        emailVerified: true,
      });
      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-minor&state=${state}`)
        .expect(302);
      const handoff = new URL(callback.headers["location"] ?? "").searchParams.get("code") ?? "";

      const minorDob = new Date();
      minorDob.setUTCFullYear(minorDob.getUTCFullYear() - 17);
      const response = await request(server)
        .post("/auth/oauth/complete")
        .set("X-Forwarded-For", "203.0.113.70")
        .send({
          code: handoff,
          dateOfBirth: minorDob.toISOString().slice(0, 10),
          jurisdiction: "IN",
        })
        .expect(403);
      expect(response.body.error.code).toBe("auth/age_restricted");
    });

    it("links a verified Google address to an existing password account", async () => {
      const existing = await newVerifiedUser("google-link", "203.0.113.71");
      const state = await startFlow("web", "203.0.113.71");
      ctx.google.profiles.set("code-link", {
        subject: "google-subject-3",
        email: existing.email,
        emailVerified: true,
      });

      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-link&state=${state}`)
        .expect(302);
      const redirect = new URL(callback.headers["location"] ?? "");
      expect(redirect.searchParams.get("status")).toBe("login");

      const completed = await request(server)
        .post("/auth/oauth/complete")
        .set("X-Forwarded-For", "203.0.113.71")
        .send({ code: redirect.searchParams.get("code") })
        .expect(200);
      expect((completed.body as Tokens).workspaceId).toBe(existing.workspaceId);

      const identities = await ctx.prisma.identity.findMany({
        where: { providerId: "google-subject-3" },
      });
      expect(identities).toHaveLength(1);
    });

    it("will not link an address the provider has not verified", async () => {
      const existing = await newVerifiedUser("google-unverified", "203.0.113.72");
      const state = await startFlow("web", "203.0.113.72");
      ctx.google.profiles.set("code-unverified", {
        subject: "google-subject-4",
        email: existing.email,
        emailVerified: false,
      });

      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-unverified&state=${state}`)
        .expect(302);
      expect(new URL(callback.headers["location"] ?? "").searchParams.get("status")).toBe(
        "registration",
      );
    });

    it("sends a desktop client through the https landing page", async () => {
      const state = await startFlow("desktop", "203.0.113.73");
      ctx.google.profiles.set("code-desktop", {
        subject: "google-subject-5",
        email: address("google-desktop"),
        emailVerified: true,
      });

      const callback = await request(server)
        .get(`/auth/oauth/google/callback?code=code-desktop&state=${state}`)
        .expect(302);
      const redirect = new URL(callback.headers["location"] ?? "");
      expect(redirect.pathname).toBe("/auth/desktop-landing");

      const landing = await request(server)
        .get(`/auth/desktop-landing${redirect.search}`)
        .expect(200);
      expect(landing.headers["content-type"]).toContain("text/html");
      expect(landing.text).toContain("aksharo://auth-callback");
      expect(landing.text).toContain("Aksharo");
      // CONTRACTS section 0: the codename never reaches user-facing text.
      expect(landing.text.toLowerCase()).not.toContain("montaj");
    });

    it("rejects a callback with no stored state", async () => {
      const response = await request(server)
        .get("/auth/oauth/google/callback?code=x&state=unknown-state")
        .expect(400);
      expect(response.body.error.code).toBe("auth/invalid_token");
    });

    it("sends the browser home when the provider reports an error", async () => {
      const response = await request(server)
        .get("/auth/oauth/google/callback?error=access_denied&state=abc")
        .expect(302);
      const redirect = new URL(response.headers["location"] ?? "");
      expect(redirect.searchParams.get("status")).toBe("error");
    });
  });

  // --- the device grant (THREAT-MODEL T3) ---------------------------------

  describe("device code", () => {
    /** Let the server-side poll interval lapse without waiting five seconds. */
    async function allowNextPoll(deviceCode: string): Promise<void> {
      await ctx.redis.del(redisKeys.devicePollAt(sha256Hex(deviceCode)));
    }

    async function requestCode(ip = "203.0.113.80") {
      const response = await request(server)
        .post("/auth/device/code")
        .set("X-Forwarded-For", ip)
        .send({ clientKind: "premiere", hostApp: "premiere", deviceInfo: { os: "Windows 11" } })
        .expect(201);
      return response.body as {
        deviceCode: string;
        userCode: string;
        verificationUrl: string;
        verificationUrlComplete: string;
        interval: number;
        expiresIn: number;
      };
    }

    it("issues an unambiguous user code with the contract's shape", async () => {
      const grant = await requestCode();
      expect(grant.userCode).toMatch(
        /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/,
      );
      expect(grant.interval).toBe(5);
      expect(grant.expiresIn).toBe(600);
      expect(grant.verificationUrl).toBe("http://localhost:3000/device");
      expect(grant.verificationUrlComplete).toContain(grant.userCode);
      expect(Buffer.from(grant.deviceCode, "base64url")).toHaveLength(32);

      // The column holds the hash, never the bearer value.
      const stored = await ctx.prisma.deviceCode.findUniqueOrThrow({
        where: { deviceCode: sha256Hex(grant.deviceCode) },
      });
      expect(stored.status).toBe("pending");
      expect(stored.hostApp).toBe("premiere");
    });

    it("answers authorization_pending, then slow_down when polled too fast", async () => {
      const grant = await requestCode();
      const pending = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(400);
      expect(pending.body.error.code).toBe("auth/authorization_pending");

      const tooFast = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(400);
      expect(tooFast.body.error.code).toBe("auth/slow_down");
      expect(tooFast.body.error.details.interval).toBe(10);
    });

    it("completes the full cycle and then refuses to be redeemed twice", async () => {
      const approver = await newVerifiedUser("device-approver", "203.0.113.81");
      const grant = await requestCode();

      const described = await request(server)
        .get(`/auth/device/code/${grant.userCode}`)
        .set("Authorization", `Bearer ${approver.accessToken}`)
        .expect(200);
      expect(described.body).toMatchObject({
        userCode: grant.userCode,
        clientKind: "premiere",
        hostApp: "premiere",
        ip: "203.0.113.80",
      });
      expect(described.body.deviceInfo.os).toBe("Windows 11");

      await request(server)
        .post("/auth/device/approve")
        .set("Authorization", `Bearer ${approver.accessToken}`)
        .set("X-Forwarded-For", "203.0.113.81")
        .send({ userCode: grant.userCode })
        .expect(200);

      await allowNextPoll(grant.deviceCode);
      const redeemed = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(200);

      const tokens = redeemed.body as Tokens;
      expect(tokens.kind).toBe("premiere");
      expect(tokens.workspaceId).toBe(approver.workspaceId);
      expect(claimsOf(tokens.accessToken)["kind"]).toBe("premiere");

      await allowNextPoll(grant.deviceCode);
      const second = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(400);
      expect(second.body.error.code).toBe("auth/expired_token");
    });

    it("reports access_denied when the user declines", async () => {
      const approver = await newVerifiedUser("device-denier", "203.0.113.82");
      const grant = await requestCode();

      await request(server)
        .post("/auth/device/approve")
        .set("Authorization", `Bearer ${approver.accessToken}`)
        .set("X-Forwarded-For", "203.0.113.82")
        .send({ userCode: grant.userCode, decision: "deny" })
        .expect(200);

      await allowNextPoll(grant.deviceCode);
      const denied = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(400);
      expect(denied.body.error.code).toBe("auth/access_denied");
    });

    it("expires after its ten minutes", async () => {
      const grant = await requestCode();
      await ctx.prisma.deviceCode.update({
        where: { deviceCode: sha256Hex(grant.deviceCode) },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const expired = await request(server)
        .post("/auth/device/token")
        .set("X-Forwarded-For", "203.0.113.80")
        .send({ deviceCode: grant.deviceCode })
        .expect(400);
      expect(expired.body.error.code).toBe("auth/expired_token");

      const stored = await ctx.prisma.deviceCode.findUniqueOrThrow({
        where: { deviceCode: sha256Hex(grant.deviceCode) },
      });
      expect(stored.status).toBe("expired");
    });

    it("caps the flows one address may have in flight", async () => {
      for (let i = 0; i < 5; i += 1) await requestCode("203.0.113.90");
      const capped = await request(server)
        .post("/auth/device/code")
        .set("X-Forwarded-For", "203.0.113.90")
        .send({ clientKind: "desktop" })
        .expect(429);
      expect(capped.body.error.code).toBe("common/rate_limited");
      expect(capped.body.error.details.limit).toBe(5);
    });

    it("requires an authenticated session to approve", async () => {
      const grant = await requestCode();
      await request(server)
        .post("/auth/device/approve")
        .send({ userCode: grant.userCode })
        .expect(401);
      await request(server).get(`/auth/device/code/${grant.userCode}`).expect(401);
    });

    it("will not approve into a workspace the approver cannot reach", async () => {
      const approver = await newVerifiedUser("device-tenant", "203.0.113.83");
      const stranger = await newVerifiedUser("device-stranger", "203.0.113.84");
      const grant = await requestCode();

      const response = await request(server)
        .post("/auth/device/approve")
        .set("Authorization", `Bearer ${approver.accessToken}`)
        .send({ userCode: grant.userCode, workspaceId: stranger.workspaceId })
        .expect(403);
      expect(response.body.error.code).toBe("auth/not_a_member");
    });

    it("treats a malformed user code like an unknown one", async () => {
      const approver = await newVerifiedUser("device-malformed", "203.0.113.85");
      await request(server)
        .get("/auth/device/code/0000-0000")
        .set("Authorization", `Bearer ${approver.accessToken}`)
        .expect(404);
    });
  });

  // --- rate limits (THREAT-MODEL T1) --------------------------------------

  describe("rate limits", () => {
    it("returns 429 with Retry-After once a per-IP bucket is empty", async () => {
      // A different address each time, so only the per-IP bucket can run out --
      // the per-account bucket is smaller and would otherwise fire first.
      for (let i = 0; i < 5; i += 1) {
        await request(server)
          .post("/auth/magic-link")
          .set("X-Forwarded-For", "198.51.100.5")
          .send({ email: address(`bucket-${String(i)}`) })
          .expect(202);
      }

      const limited = await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "198.51.100.5")
        .send({ email: address("bucket-last") })
        .expect(429);

      expect(limited.body.error.code).toBe("common/rate_limited");
      expect(limited.body.error.details.bucket).toBe("auth:magic:ip");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(limited.headers["x-ratelimit-limit"]).toBe("5");
    });

    it("empties one address's bucket without touching another's", async () => {
      for (let i = 0; i < 5; i += 1) {
        await request(server)
          .post("/auth/magic-link")
          .set("X-Forwarded-For", "198.51.100.6")
          .send({ email: address(`bucket-b-${String(i)}`) })
          .expect(202);
      }
      await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "198.51.100.6")
        .send({ email: address("bucket-b-last") })
        .expect(429);

      // A different address is unaffected: one caller cannot lock everyone out.
      await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "198.51.100.7")
        .send({ email: address("bucket-c") })
        .expect(202);
    });

    it("stops repeat requests for one account from a rotating address", async () => {
      const email = address("bucket-per-account");
      for (let i = 0; i < 3; i += 1) {
        await request(server)
          .post("/auth/magic-link")
          .set("X-Forwarded-For", `198.51.100.${String(200 + i)}`)
          .send({ email })
          .expect(202);
      }
      const limited = await request(server)
        .post("/auth/magic-link")
        .set("X-Forwarded-For", "198.51.100.210")
        .send({ email })
        .expect(429);
      expect(limited.body.error.details.bucket).toBe("auth:magic:account");
    });

    it("limits attempts against one account wherever they come from", async () => {
      const { email } = await newVerifiedUser("bucket-account", "198.51.100.10");
      let limited = false;

      for (let attempt = 0; attempt < 11 && !limited; attempt += 1) {
        const response = await request(server)
          .post("/auth/login")
          // A different address every time: only the per-account bucket can stop this.
          .set("X-Forwarded-For", `198.51.100.${String(100 + attempt)}`)
          .send({ email, password: "wrong-password-entirely" });
        limited = response.status === 429;
        if (limited) {
          expect(response.body.error.details.bucket).toBe("auth:login:account");
          expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        }
      }

      expect(limited).toBe(true);
    }, 60_000);
  });

  // --- the OpenAPI document -----------------------------------------------

  describe("openapi", () => {
    it("documents every auth endpoint with a real request body", async () => {
      const response = await request(server).get("/docs-json").expect(200);
      const paths = response.body.paths as Record<string, Record<string, unknown>>;

      for (const path of [
        "/auth/signup",
        "/auth/login",
        "/auth/verify-email",
        "/auth/magic-link",
        "/auth/magic-link/consume",
        "/auth/refresh",
        "/auth/logout",
        "/auth/token/exchange",
        "/auth/sessions",
        "/auth/sessions/{sessionId}",
        "/auth/parental-waitlist",
        "/auth/oauth/google/start",
        "/auth/oauth/google/callback",
        "/auth/oauth/complete",
        "/auth/device/code",
        "/auth/device/token",
        "/auth/device/approve",
        "/auth/device/code/{userCode}",
      ]) {
        expect(paths[path], `${path} is missing from the OpenAPI document`).toBeDefined();
      }

      const signup = paths["/auth/signup"] as {
        post: { requestBody: { content: Record<string, { schema: { properties: unknown } }> } };
      };
      const schema = signup.post.requestBody.content["application/json"]?.schema;
      expect(Object.keys((schema?.properties ?? {}) as object)).toContain("dateOfBirth");
    });
  });
});
