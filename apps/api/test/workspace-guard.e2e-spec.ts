/**
 * THREAT-MODEL **T4** — tenant confusion — as a contract test.
 *
 * The rule is "every `/workspaces/:id` route requires an active membership of the
 * workspace in the token's `ws` claim". A rule stated in a README rots the moment
 * somebody adds a route and forgets the guard, so this suite does not assert a
 * list of routes somebody wrote down: it **enumerates the shipped route table**
 * from the Nest router, filters it to the ones carrying `:id`, and drives a real
 * request at every one of them as a non-member. A route added tomorrow without
 * the guard fails here without anybody editing this file.
 *
 * Two callers are used, because a workspace id can be wrong in two ways:
 *
 *   * a **stranger** — never a member of anything shared with the victim;
 *   * a **removed member** — whose access token is still inside its fifteen
 *     minutes and still carries `role`, which is exactly the window a demotion
 *     would otherwise survive.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authSkipReason, createAuthTestContext } from "./auth-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";

import type { AuthTestContext } from "./auth-harness.js";
import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[workspace-guard.e2e] SKIPPED - ${skipReason}`);
}

const PASSWORD = "correct-horse-battery-staple";
const ADULT_DOB = "1996-01-15";
const IP = "203.0.113.30";

interface Route {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
}

/**
 * Every route the application actually serves, read out of the Express router
 * underneath Nest. Deliberately not read from the OpenAPI document: a route
 * excluded from the document (`@ApiExcludeEndpoint`) is still a route an attacker
 * can call.
 */
function routeTable(app: INestApplication): Route[] {
  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack: unknown[] };
    _router?: { stack: unknown[] };
  };
  const stack = (server.router ?? server._router)?.stack ?? [];
  const routes: Route[] = [];

  for (const layer of stack as { route?: { path: string; methods: Record<string, boolean> } }[]) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      routes.push({ method: method as Route["method"], path: layer.route.path });
    }
  }
  return routes;
}

describe.skipIf(!available)("the workspace membership guard (T4)", () => {
  let ctx: AuthTestContext;
  let server: Server;
  /** The victim's workspace, and two callers who must never reach it. */
  let victimWorkspaceId: string;
  let strangerToken: string;
  let removedMemberToken: string;
  let membershipId: string;
  let guardedRoutes: Route[];

  beforeAll(async () => {
    const created = await createAuthTestContext();
    if (created === null) throw new Error(`harness unavailable: ${authSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
    await ctx.reset();

    guardedRoutes = routeTable(ctx.app).filter(
      (route) => route.path.startsWith("/workspaces/") && route.path.includes(":id"),
    );

    const victim = await newUser("victim");
    const stranger = await newUser("stranger");
    const removed = await newUser("removed");

    // The victim owns a team workspace; `removed` joins it and is then removed,
    // keeping the access token minted while they were still a member.
    const team = await request(server)
      .post("/workspaces")
      .set("Authorization", `Bearer ${victim.accessToken}`)
      .send({ name: "Guarded" })
      .expect(201);
    victimWorkspaceId = team.body.id as string;

    const asOwner = await exchange(victim.accessToken, victimWorkspaceId);
    const invitation = await request(server)
      .post(`/workspaces/${victimWorkspaceId}/members`)
      .set("Authorization", `Bearer ${asOwner}`)
      .send({ email: removed.email, role: "admin" })
      .expect(201);
    membershipId = invitation.body.id as string;

    await request(server)
      .post(`/invitations/${membershipId}/accept`)
      .set("Authorization", `Bearer ${removed.accessToken}`)
      .expect(201);
    removedMemberToken = await exchange(removed.accessToken, victimWorkspaceId);

    // The stranger's token is scoped to their own personal workspace.
    strangerToken = stranger.accessToken;

    await request(server)
      .delete(`/workspaces/${victimWorkspaceId}/members/${membershipId}`)
      .set("Authorization", `Bearer ${asOwner}`)
      .expect(200);
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  async function newUser(label: string) {
    const email = `${label}-${Date.now().toString(36)}@example.test`;
    await request(server)
      .post("/auth/signup")
      .set("X-Forwarded-For", IP)
      .send({ email, password: PASSWORD, dateOfBirth: ADULT_DOB, jurisdiction: "IN" })
      .expect(202);
    const outbox = await ctx.outbox();
    const token = outbox.find(
      (entry) => entry.template === "email_verification" && entry.to === email,
    )?.token;
    await request(server)
      .post("/auth/verify-email")
      .set("X-Forwarded-For", IP)
      .send({ token })
      .expect(200);
    const login = await request(server)
      .post("/auth/login")
      .set("X-Forwarded-For", IP)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { ...(login.body as { accessToken: string; workspaceId: string }), email };
  }

  async function exchange(accessToken: string, workspaceId: string): Promise<string> {
    const response = await request(server)
      .post("/auth/token/exchange")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("X-Forwarded-For", IP)
      .send({ workspaceId })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /** Fill `:id` with the victim's workspace and every other parameter with a ULID. */
  function concrete(route: Route): string {
    return route.path
      .replace(":id", victimWorkspaceId)
      .replace(":membershipId", membershipId)
      .replace(/:[A-Za-z]+/g, "01JPLACEHOLDER0000000000AA");
  }

  function call(route: Route, token: string) {
    return request(server)[route.method](concrete(route)).set("Authorization", `Bearer ${token}`);
  }

  it("found the routes it is supposed to be guarding", () => {
    // A regression where the controller stops registering routes would otherwise
    // make every assertion below vacuously true.
    expect(guardedRoutes.length).toBeGreaterThanOrEqual(7);
    const paths = new Set(
      guardedRoutes.map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    for (const expected of [
      "GET /workspaces/:id",
      "PATCH /workspaces/:id",
      "DELETE /workspaces/:id",
      "PUT /workspaces/:id/tax-profile",
      "GET /workspaces/:id/entitlement",
      "GET /workspaces/:id/members",
      "POST /workspaces/:id/members",
      "PATCH /workspaces/:id/members/:membershipId",
      "DELETE /workspaces/:id/members/:membershipId",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("answers 403 auth/not_a_member on every :id route for a stranger", async () => {
    for (const route of guardedRoutes) {
      const response = await call(route, strangerToken).send({});
      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path} let a non-member through`,
      ).toBe(403);
      expect(response.body.error.code).toBe("auth/not_a_member");
    }
  });

  it("answers 403 on every :id route for a member who has been removed", async () => {
    // The token is still inside its fifteen minutes and still says `role: admin`.
    for (const route of guardedRoutes) {
      const response = await call(route, removedMemberToken).send({});
      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path} honoured a stale membership`,
      ).toBe(403);
      expect(response.body.error.code).toBe("auth/not_a_member");
    }
  });

  it("answers 401, not 403, when there is no token at all", async () => {
    for (const route of guardedRoutes) {
      const response = await request(server)[route.method](concrete(route)).send({});
      expect(response.status).toBe(401);
    }
  });

  it("ignores a workspace supplied in a header (07 §Conventions)", async () => {
    // There is no `X-Workspace-Id` header. Sending one changes nothing, which is
    // the property T4 is about.
    const response = await request(server)
      .get(`/workspaces/${victimWorkspaceId}`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .set("X-Workspace-Id", victimWorkspaceId)
      .expect(403);
    expect(response.body.error.code).toBe("auth/not_a_member");
  });

  it("leaves the collection routes reachable, because they name no workspace", async () => {
    await request(server)
      .get("/workspaces")
      .set("Authorization", `Bearer ${strangerToken}`)
      .expect(200);
  });
});
