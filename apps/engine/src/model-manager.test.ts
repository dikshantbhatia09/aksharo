import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseManifest } from "./manifest.js";
import { ModelManager, ModelManagerError } from "./model-manager.js";

import type { EngineManifest } from "./manifest.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestFor(bytes: Buffer, path = "models/a.bin"): EngineManifest {
  return parseManifest({
    v: 1,
    generatedAt: "x",
    defaultAsrModel: "a",
    fallbackAsrModel: "a",
    entries: [
      { id: "a", kind: "asr", version: "1", path, sizeBytes: bytes.length, sha256: sha256(bytes) },
    ],
  });
}

/** A minimal fetch fake serving one fixed payload, with Range support for resume tests. */
function fakeFetch(payload: Buffer): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.["range"];
    if (range !== undefined) {
      const match = /bytes=(\d+)-/.exec(range);
      const offset = match ? Number(match[1]) : 0;
      const slice = payload.subarray(offset);
      return new Response(slice, { status: 206 });
    }
    return new Response(payload, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("ModelManager", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "model-manager-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("downloads and verifies a model, landing the file at the manifest path", async () => {
    const payload = Buffer.from("hello world model bytes");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(payload),
    });

    await manager.download("a");
    const onDisk = readFileSync(join(dir, "models/a.bin"));
    expect(onDisk.equals(payload)).toBe(true);

    const statuses = await manager.listStatuses();
    expect(statuses[0]?.state).toBe("installed");
  });

  it("throws checksum_mismatch and removes the bad file when the server returns different bytes", async () => {
    const payload = Buffer.from("expected bytes");
    const wrongPayload = Buffer.from("tampered!!!!!!!");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(wrongPayload),
    });

    await expect(manager.download("a")).rejects.toMatchObject({ code: "checksum_mismatch" });
    const statuses = await manager.listStatuses();
    expect(statuses[0]?.state).toBe("failed");
  });

  it("rejects a download that would exceed the disk budget", async () => {
    const payload = Buffer.alloc(2000, 1);
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1000,
      fetchImpl: fakeFetch(payload),
    });

    await expect(manager.download("a")).rejects.toBeInstanceOf(ModelManagerError);
    await expect(manager.download("a")).rejects.toMatchObject({ code: "disk_budget_exceeded" });
  });

  it("resumes a partial .part file via Range", async () => {
    const payload = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(payload),
    });

    // Seed a partial download by hand.
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(dir, "models"), { recursive: true });
    await fs.writeFile(join(dir, "models/a.bin.part"), payload.subarray(0, 10));

    await manager.download("a");
    const onDisk = readFileSync(join(dir, "models/a.bin"));
    expect(onDisk.equals(payload)).toBe(true);
  });

  it("delete removes the installed file", async () => {
    const payload = Buffer.from("deletable bytes");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(payload),
    });
    await manager.download("a");
    await manager.delete("a");
    const statuses = await manager.listStatuses();
    expect(statuses[0]?.state).toBe("available");
  });

  it("modelsMissing is true until at least one entry is fully installed", async () => {
    const payload = Buffer.from("present bytes");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(payload),
    });
    expect(await manager.modelsMissing()).toBe(true);
    await manager.download("a");
    expect(await manager.modelsMissing()).toBe(false);
  });

  it("verifyAll re-checks hashes on launch and flags a tampered file (T22)", async () => {
    const payload = Buffer.from("verify me please");
    const manifest = manifestFor(payload);
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
      fetchImpl: fakeFetch(payload),
    });
    await manager.download("a");

    const before = await manager.verifyAll();
    expect(before.verified).toEqual(["a"]);
    expect(before.failed).toEqual([]);

    // Tamper with the installed file without changing its size.
    const fs = await import("node:fs/promises");
    const tampered = Buffer.from(payload);
    tampered[0] = tampered[0] === 0x41 ? 0x42 : 0x41;
    await fs.writeFile(join(dir, "models/a.bin"), tampered);

    const after = await manager.verifyAll();
    expect(after.failed).toEqual(["a"]);
  });

  it("throws not_found for an unknown model id", async () => {
    const manifest = manifestFor(Buffer.from("x"));
    const manager = new ModelManager({
      manifest,
      baseUrl: "https://models.example",
      modelsDir: dir,
      diskBudgetBytes: 1_000_000,
    });
    await expect(manager.download("does-not-exist")).rejects.toMatchObject({ code: "not_found" });
  });
});
