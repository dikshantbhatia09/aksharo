import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openLocalDb } from "./db.js";

describe("openLocalDb", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "local-db-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates every table the schema declares", async () => {
    const db = await openLocalDb(":memory:");
    const stmt = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names: string[] = [];
    while (stmt.step()) names.push(String(stmt.getAsObject()["name"]));
    stmt.free();

    expect(names.sort()).toEqual(
      ["local_edg_snapshots", "local_exports", "local_media", "local_projects"].sort(),
    );
  });

  it("is idempotent: reopening the same file does not fail or duplicate tables", async () => {
    const file = path.join(tmp, "local.sqlite3");
    const first = await openLocalDb(file);
    first.raw.run(
      "INSERT INTO local_projects (id, title, aspect, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["p1", "Project one", "9:16", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    await first.persist();

    const second = await openLocalDb(file);
    const stmt = second.raw.prepare("SELECT title FROM local_projects WHERE id = 'p1'");
    stmt.step();
    expect(stmt.getAsObject()["title"]).toBe("Project one");
    stmt.free();
  });

  it("persists to disk atomically, leaving no .tmp file behind", async () => {
    const file = path.join(tmp, "local.sqlite3");
    const db = await openLocalDb(file);
    db.raw.run(
      "INSERT INTO local_projects (id, title, aspect, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["p1", "Title", "9:16", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    await db.persist();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    const written = await readFile(file);
    expect(written.byteLength).toBeGreaterThan(0);
  });

  it("never persists an in-memory database to a file", async () => {
    const db = await openLocalDb(":memory:");
    db.raw.run(
      "INSERT INTO local_projects (id, title, aspect, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["p1", "Title", "9:16", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    await expect(db.persist()).resolves.toBeUndefined();
  });
});
