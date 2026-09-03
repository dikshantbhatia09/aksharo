import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EdgHot, Segment, TranscriptChunk } from "@montaj/edg/schemas";
import type {
  EngineClient,
  ProbeResponse,
  RenderResponse,
  TranscribeResponse,
} from "@montaj/engine-client";

import { openLocalDb, type LocalDb } from "./db.js";
import { EngineUnavailableError, LocalProjectNotFoundError, LocalStore } from "./store.js";

/** A deterministic fake of the engine client's methods the store calls. */
function fakeEngine(overrides: Partial<EngineClient> = {}): EngineClient {
  return {
    transcribe: vi.fn(
      async () =>
        ({
          language: "hi-Latn",
          languageProbability: 0.98,
          durationS: 12,
          model: "ggml-large-v3-turbo-q5_0",
          requestId: "req-1",
          words: [],
          segments: [],
          engineVersions: {},
          usage: { audioSeconds: 12, model: "ggml-large-v3-turbo-q5_0" },
          backend: "fake",
        }) satisfies TranscribeResponse,
    ),
    align: vi.fn(),
    clean: vi.fn(),
    render: vi.fn(
      async () =>
        ({
          outputPath: "/tmp/out.mp4",
          frameCount: 300,
          durationS: 10,
          requestId: "req-2",
          engineVersions: {},
          backend: "fake",
        }) satisfies RenderResponse,
    ),
    probe: vi.fn(
      async () =>
        ({
          durationMs: 12_000,
          fps: 30,
          width: 1080,
          height: 1920,
          audioChannels: 2,
          audioSampleRateHz: 48_000,
          hdr: false,
          requestId: "req-3",
          engineVersions: {},
          backend: "fake",
        }) satisfies ProbeResponse,
    ),
    health: vi.fn(),
    models: vi.fn(),
    downloadModel: vi.fn(),
    deleteModel: vi.fn(),
    transcribeStream: vi.fn(),
    ...overrides,
  } as unknown as EngineClient;
}

function sampleDoc(projectId: string): { hot: EdgHot; segments: Segment[] } {
  return {
    hot: {
      meta: { edgId: "01JAAA0000000000000000000A", projectId, revision: 0, schemaVersion: 2 },
      media: [],
      transcript: {
        transcriptId: "01JAAA0000000000000000000B",
        revision: 1,
        language: "hi-Latn",
        scripts: ["roman"],
      },
      canvas: { aspect: "9:16", width: 1080, height: 1920 },
      styles: { defaultStyleId: "clean-bold" },
    },
    segments: [
      {
        id: "01JAAA0000000000000000000C",
        seq: "V",
        startWordId: "0:0",
        endWordId: "0:0",
        startMs: 0,
        endMs: 400,
      } as Segment,
    ],
  };
}

function sampleChunk(): TranscriptChunk {
  return {
    chunkIdx: 0,
    startMs: 0,
    endMs: 400,
    words: [{ wid: "0:0", s: 0, e: 400, t: "Namaste" }],
  };
}

describe("LocalStore", () => {
  let tmp: string;
  let db: LocalDb;
  let mediaDir: string;
  let sourceFile: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "local-store-"));
    db = await openLocalDb(":memory:");
    mediaDir = path.join(tmp, "media");
    sourceFile = path.join(tmp, "clip.mp4");
    await writeFile(sourceFile, "fake video bytes");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("round-trips a project: create -> import media -> transcribe -> save EDG -> export", async () => {
    const engine = fakeEngine();
    const store = new LocalStore({
      db,
      mediaDir,
      engine,
      newId: (() => {
        let n = 0;
        return () => `id-${String((n += 1))}`;
      })(),
    });

    const project = await store.createProject({ title: "My clip", aspect: "9:16" });
    expect(store.listProjects()).toHaveLength(1);

    const media = await store.importMedia({
      projectId: project.id,
      sourcePath: sourceFile,
      role: "primary",
    });
    expect(media.filePath).not.toBe(sourceFile);
    expect(store.listMedia(project.id)).toEqual([media]);

    const transcript = await store.transcribe({ audio: media.filePath });
    expect(engine.transcribe).toHaveBeenCalledWith({ audio: media.filePath });
    expect(transcript.backend).toBe("fake");

    const { hot, segments } = sampleDoc(project.id);
    const snapshot = await store.saveEdgSnapshot({ projectId: project.id, hot, segments });
    expect(snapshot.revision).toBe(1);
    expect(store.latestSnapshot(project.id)).toEqual(snapshot);

    // A second save advances the revision rather than overwriting it.
    const second = await store.saveEdgSnapshot({ projectId: project.id, hot, segments });
    expect(second.revision).toBe(2);
    expect(store.latestSnapshot(project.id)?.revision).toBe(2);

    const outputPath = path.join(tmp, "out.mp4");
    const exported = await store.runExport({
      projectId: project.id,
      drawCommandsPath: path.join(tmp, "draw-commands.json"),
      width: 1080,
      height: 1920,
      fps: 30,
      outputPath,
    });
    expect(exported.status).toBe("done");
    expect(store.listExports(project.id)).toHaveLength(1);
  });

  it("throws for an unknown project on every operation that needs one", async () => {
    const store = new LocalStore({ db, mediaDir, engine: fakeEngine() });
    expect(() => store.openProject("missing")).toThrow(LocalProjectNotFoundError);
    await expect(
      store.importMedia({ projectId: "missing", sourcePath: sourceFile, role: "primary" }),
    ).rejects.toThrow(LocalProjectNotFoundError);
    await expect(
      store.saveEdgSnapshot({ projectId: "missing", ...sampleDoc("missing") }),
    ).rejects.toThrow(LocalProjectNotFoundError);
  });

  it("throws EngineUnavailableError rather than silently no-op-ing when the engine is down (tier D)", async () => {
    const store = new LocalStore({ db, mediaDir, engine: null });
    const project = await store.createProject({ title: "No engine", aspect: "9:16" });
    await expect(store.transcribe({ audio: "x" })).rejects.toThrow(EngineUnavailableError);
    await expect(
      store.runExport({
        projectId: project.id,
        drawCommandsPath: "x",
        width: 1,
        height: 1,
        fps: 30,
        outputPath: "y",
      }),
    ).rejects.toThrow(EngineUnavailableError);
    const exports = store.listExports(project.id);
    expect(exports[0]?.status).toBe("failed");
  });

  it("marks an export failed (not silently swallowed) when the engine's render rejects", async () => {
    const engine = fakeEngine({ render: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const store = new LocalStore({ db, mediaDir, engine });
    const project = await store.createProject({ title: "Boom", aspect: "9:16" });

    await expect(
      store.runExport({
        projectId: project.id,
        drawCommandsPath: "x",
        width: 1,
        height: 1,
        fps: 30,
        outputPath: "y",
      }),
    ).rejects.toThrow("boom");
    expect(store.listExports(project.id)[0]?.status).toBe("failed");
  });

  it("deletes a project, its media files, snapshots and exports", async () => {
    const store = new LocalStore({ db, mediaDir, engine: fakeEngine() });
    const project = await store.createProject({ title: "Doomed", aspect: "9:16" });
    const media = await store.importMedia({
      projectId: project.id,
      sourcePath: sourceFile,
      role: "primary",
    });
    await store.saveEdgSnapshot({ projectId: project.id, ...sampleDoc(project.id) });

    await store.deleteProject(project.id);

    expect(store.listProjects()).toHaveLength(0);
    expect(store.listMedia(project.id)).toHaveLength(0);
    expect(store.latestSnapshot(project.id)).toBeNull();
    await expect(rm(media.filePath, { force: false })).rejects.toThrow(); // the file is gone
  });

  it("probes an imported media file via the engine and stores duration/fps/dimensions", async () => {
    const engine = fakeEngine();
    const store = new LocalStore({ db, mediaDir, engine });
    const project = await store.createProject({ title: "Probed", aspect: "9:16" });

    const media = await store.importMedia({
      projectId: project.id,
      sourcePath: sourceFile,
      role: "primary",
    });

    expect(engine.probe).toHaveBeenCalledWith({ path: media.filePath });
    expect(media.durationMs).toBe(12_000);
    expect(media.fps).toBe(30);
    expect(media.width).toBe(1080);
    expect(media.height).toBe(1920);
  });

  it("leaves probe fields null (not throwing) when the engine is unavailable", async () => {
    const store = new LocalStore({ db, mediaDir, engine: null });
    const project = await store.createProject({ title: "No engine", aspect: "9:16" });
    const media = await store.importMedia({
      projectId: project.id,
      sourcePath: sourceFile,
      role: "primary",
    });
    expect(media.durationMs).toBeNull();
    expect(media.fps).toBeNull();
  });

  it("leaves probe fields null when the caller already supplies them, without re-probing", async () => {
    const engine = fakeEngine();
    const store = new LocalStore({ db, mediaDir, engine });
    const project = await store.createProject({ title: "Explicit probe", aspect: "9:16" });
    const media = await store.importMedia({
      projectId: project.id,
      sourcePath: sourceFile,
      role: "primary",
      probe: { durationMs: 5000, fps: 24, width: 640, height: 360 },
    });
    expect(engine.probe).not.toHaveBeenCalled();
    expect(media.durationMs).toBe(5000);
    expect(media.fps).toBe(24);
  });

  it("round-trips transcript chunks through save/latest snapshot", async () => {
    const store = new LocalStore({ db, mediaDir, engine: fakeEngine() });
    const project = await store.createProject({ title: "Chunks", aspect: "9:16" });
    const { hot, segments } = sampleDoc(project.id);
    const chunk = sampleChunk();

    const saved = await store.saveEdgSnapshot({
      projectId: project.id,
      hot,
      segments,
      chunks: [chunk],
    });
    expect(saved.chunks).toEqual([chunk]);
    expect(store.latestSnapshot(project.id)?.chunks).toEqual([chunk]);
    expect(store.transcriptChunks(project.id)).toEqual([chunk]);

    // A word edit patches the chunk's row in place rather than duplicating it.
    const edited: TranscriptChunk = {
      ...chunk,
      words: [{ ...chunk.words[0]!, t: "Bhai" }],
    };
    const second = await store.saveEdgSnapshot({
      projectId: project.id,
      hot,
      segments,
      chunks: [edited],
    });
    expect(second.chunks).toEqual([edited]);
    expect(store.transcriptChunks(project.id)).toHaveLength(1);
  });

  it("leaves existing chunks untouched when a save omits them (a pure segment-level edit)", async () => {
    const store = new LocalStore({ db, mediaDir, engine: fakeEngine() });
    const project = await store.createProject({ title: "Chunks", aspect: "9:16" });
    const { hot, segments } = sampleDoc(project.id);
    const chunk = sampleChunk();

    await store.saveEdgSnapshot({ projectId: project.id, hot, segments, chunks: [chunk] });
    const second = await store.saveEdgSnapshot({ projectId: project.id, hot, segments });
    expect(second.chunks).toEqual([chunk]);
  });
});
