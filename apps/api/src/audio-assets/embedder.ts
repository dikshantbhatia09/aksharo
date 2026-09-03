import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The `Embedder` boundary (H-22): the frozen LAION CLAP checkpoint is a model
 * weight, never committed, provisioned by an env path
 * (`CLAP_MODEL_PATH`/`worker-ai`'s settings). This machine does not have the
 * weights, so the default path here is a deterministic stub — same interface,
 * same 512-dim output shape — and the real path shells out to
 * `apps/worker-ai`'s `python -m worker_ai.audio_embed`, which is the module
 * that actually loads the checkpoint (marked `slow` in its own test suite).
 *
 * Ingestion is an offline CLI, run once per pack, not a queued job — CONTRACTS
 * §3 lists no `ai.audio_embed` queue, and adding one for a one-shot batch tool
 * is not warranted, so this calls the worker-ai module as a subprocess rather
 * than round-tripping through BullMQ.
 */
export interface Embedder {
  embed(filePath: string): Promise<readonly number[]>;
}

const EMBEDDING_DIMS = 512;

/**
 * A deterministic, content-derived 512-dim unit vector: SHA-256 of the file
 * bytes, expanded by re-hashing with a counter, mapped into [-1, 1] and
 * L2-normalised. Same bytes always produce the same vector (retrieval
 * ranking determinism in tests); different bytes almost certainly produce a
 * different vector (SFX cues rank distinctly from one another even without a
 * real acoustic model).
 */
export class StubEmbedder implements Embedder {
  async embed(filePath: string): Promise<readonly number[]> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is the ingest CLI's own manifest-resolved local fixture/pack path, not attacker-controlled input -- reviewed for D04a
    const bytes = await readFile(filePath);
    const base = createHash("sha256").update(bytes).digest();
    const raw = new Float64Array(EMBEDDING_DIMS);
    for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
      const block = createHash("sha256")
        .update(base)
        .update(Uint8Array.of(i & 0xff, (i >> 8) & 0xff))
        .digest();
      // Map the first 4 bytes of the block to a signed unit-ish value.
      const int = block.readUInt32BE(0);
      // eslint-disable-next-line security/detect-object-injection -- i is the loop's own bounded numeric index (0..EMBEDDING_DIMS), not attacker-controlled -- reviewed for D04a
      raw[i] = (int / 0xffffffff) * 2 - 1;
    }
    const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
    return Array.from(raw, (v) => v / norm);
  }
}

/** Embeds free text the same way (SFX pass text queries) — used only by the
 * worker pass's TS-side tests; the Python pass has its own text-side stub. */
export function embedTextStub(text: string): readonly number[] {
  const base = createHash("sha256").update(text.trim().toLowerCase()).digest();
  const raw = new Float64Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
    const block = createHash("sha256")
      .update(base)
      .update(Uint8Array.of(i & 0xff, (i >> 8) & 0xff))
      .digest();
    // eslint-disable-next-line security/detect-object-injection -- i is the loop's own bounded numeric index (0..EMBEDDING_DIMS), not attacker-controlled -- reviewed for D04a
    raw[i] = (block.readUInt32BE(0) / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return Array.from(raw, (v) => v / norm);
}

/**
 * Shells out to `python -m worker_ai.audio_embed <filePath>` in the
 * worker-ai venv and parses its one-line JSON `{"embedding": [...]}` on
 * stdout. Only used when `CLAP_MODEL_PATH` is set; otherwise ingestion falls
 * back to {@link StubEmbedder} (see `ingest-audio-pack.ts`).
 */
export class ClapSubprocessEmbedder implements Embedder {
  constructor(
    private readonly pythonBinary: string,
    private readonly workerAiCwd: string,
  ) {}

  async embed(filePath: string): Promise<readonly number[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBinary, ["-m", "worker_ai.audio_embed", filePath], {
        cwd: this.workerAiCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`worker_ai.audio_embed exited ${String(code)}: ${stderr}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
          const embedding = (parsed as { embedding?: unknown }).embedding;
          if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
            reject(new Error("worker_ai.audio_embed did not return a 512-dim embedding"));
            return;
          }
          resolve(embedding as number[]);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}
