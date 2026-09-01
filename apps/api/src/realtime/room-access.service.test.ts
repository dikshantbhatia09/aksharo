import { beforeEach, describe, expect, it } from "vitest";

import { RoomAccessService } from "./room-access.service.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";

import type { AccessTokenClaims } from "./auth/access-token.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

const WS = "01JCWS0000000000000000000A";
const OTHER_WS = "01JCWS0000000000000000000B";
const USER = "01JCUSER00000000000000000A";
const PROJECT = "01JCPROJECT000000000000000";
const OTHER_PROJECT = "01JCPROJECT00000000000000B";

const CLAIMS: AccessTokenClaims = {
  sub: USER,
  ws: WS,
  role: "editor",
  kind: "web",
  jti: "01JCJTI000000000000000000A",
  iat: 0,
  exp: 0,
};

let db: FakeDb;
let access: RoomAccessService;

beforeEach(() => {
  db = new FakeDb();
  db.memberships.push({ id: "m1", workspaceId: WS, userId: USER, status: "active" });
  db.projects.push({ id: PROJECT, workspaceId: WS, deletedAt: null });
  db.projects.push({ id: OTHER_PROJECT, workspaceId: OTHER_WS, deletedAt: null });
  access = new RoomAccessService(createFakePrisma(db) as unknown as PrismaService);
});

describe("workspace rooms (THREAT-MODEL T4)", () => {
  it("allows the workspace bound into the token", async () => {
    await expect(access.canJoin(CLAIMS, { kind: "workspace", id: WS })).resolves.toEqual({
      allowed: true,
    });
  });

  it("refuses any other workspace, whatever the room name says", async () => {
    await expect(access.canJoin(CLAIMS, { kind: "workspace", id: OTHER_WS })).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("refuses a member who has been removed since the token was issued", async () => {
    db.memberships.length = 0;
    await expect(access.canJoin(CLAIMS, { kind: "workspace", id: WS })).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("refuses a suspended or merely invited membership", async () => {
    for (const status of ["invited", "suspended", "removed"]) {
      db.memberships.length = 0;
      db.memberships.push({ id: "m1", workspaceId: WS, userId: USER, status });
      await expect(access.canJoin(CLAIMS, { kind: "workspace", id: WS })).resolves.toEqual({
        allowed: false,
        reason: "forbidden",
      });
    }
  });
});

describe("project rooms (THREAT-MODEL T5)", () => {
  it("allows a project inside the token's workspace", async () => {
    await expect(access.canJoin(CLAIMS, { kind: "project", id: PROJECT })).resolves.toEqual({
      allowed: true,
    });
  });

  it("answers not_found for another workspace's project AND for one that does not exist", async () => {
    // Identical answers: the room name must not be usable to enumerate ids.
    const foreign = await access.canJoin(CLAIMS, { kind: "project", id: OTHER_PROJECT });
    const missing = await access.canJoin(CLAIMS, {
      kind: "project",
      id: "01JCPROJECT00000000000000C",
    });
    expect(foreign).toEqual({ allowed: false, reason: "not_found" });
    expect(missing).toEqual(foreign);
  });

  it("answers not_found for a soft-deleted project", async () => {
    db.projects.length = 0;
    db.projects.push({ id: PROJECT, workspaceId: WS, deletedAt: new Date() });
    await expect(access.canJoin(CLAIMS, { kind: "project", id: PROJECT })).resolves.toEqual({
      allowed: false,
      reason: "not_found",
    });
  });

  it("still requires a live membership", async () => {
    db.memberships.length = 0;
    await expect(access.canJoin(CLAIMS, { kind: "project", id: PROJECT })).resolves.toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });
});
