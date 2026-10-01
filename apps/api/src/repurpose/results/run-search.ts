import { createHash } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { type Env } from "@montaj/config";

import { PrismaService } from "../../common/index.js";
import { redisKeyPrefix } from "../../common/redis/redis-keys.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { ENV } from "../../config/config.module.js";

/**
 * Finding a run's clips by what they are about, not only by their words
 * (2026-10-01, OpusClip's "Find all the parts where ..." search).
 *
 * Each moment's words (its title, hook, summary, topics, the people it names
 * and what is said) and the question are turned into vectors by a local
 * embedding model on this machine's Ollama (`bge-m3`: multilingual, so Hindi,
 * Hinglish and English questions all work; free, no vendor), and the moments
 * are ranked by how close they are. A moment's vector is kept in Redis for 30
 * days, keyed by its text, so a run is embedded once.
 *
 * Never a failure the page has to show: with the model missing or Ollama
 * down, the answer is `{ semantic: false }` and the page keeps its word match.
 */

/** The embedding model, pulled into the local Ollama (`ollama pull bge-m3`). */
export const SEARCH_EMBED_MODEL = "bge-m3";
/**
 * When a moment counts as a match. Measured on the owner's 40-moment podcast
 * run (2026-10-01): the moment a question is about scores 0.48-0.65, and every
 * moment of an unrelated question ("cooking recipes", "football match") 0.24-0.52,
 * so no fixed line separates them. What does: the best moment standing well
 * clear of the run's middle. A question is answered only when its best moment
 * scores at least {@link SEARCH_MIN_SCORE} and {@link SEARCH_MIN_LEAD} above the
 * median moment; then every moment within {@link SEARCH_BAND} of the best is.
 */
export const SEARCH_MIN_SCORE = 0.47;
export const SEARCH_MIN_LEAD = 0.1;
export const SEARCH_BAND = 0.08;
/** The most matches returned. */
const SEARCH_MAX_MATCHES = 20;
/** A moment's text is cut here: the model's own window is longer, the meaning is in the start. */
const TEXT_MAX_CHARS = 2_000;
const VECTOR_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A cold model takes up to ~30 s to load onto the GPU; warm, 40 moments take under 1 s. */
const EMBED_TIMEOUT_MS = 60_000;
/** How long Ollama keeps the model loaded after a search (664 MB of GPU memory). */
const EMBED_KEEP_ALIVE = "30m";

export interface RunSearchMatch {
  readonly candidateId: string;
  /** Cosine similarity, 0-1. */
  readonly score: number;
}

export interface RunSearchResult {
  /** False when the meaning could not be read (no model, Ollama down): use the word match. */
  readonly semantic: boolean;
  readonly matches: readonly RunSearchMatch[];
}

interface MomentText {
  readonly id: string;
  readonly text: string;
}

/** The words a moment is searched by. */
export function momentText(candidate: {
  readonly title: string;
  readonly transcriptExcerpt: string;
  readonly copy: unknown;
  readonly judgement: unknown;
}): string {
  const copy = record(candidate.copy);
  const judgement = record(candidate.judgement);
  const hashtags = Array.isArray(copy["hashtags"])
    ? (copy["hashtags"] as unknown[])
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.replace(/^#/, ""))
    : [];
  const people = Array.isArray(judgement["people"])
    ? (judgement["people"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  return [
    candidate.title,
    text(copy["title"]),
    text(copy["hook"]),
    text(copy["summary"]),
    hashtags.join(", "),
    people.join(", "),
    candidate.transcriptExcerpt,
  ]
    .filter((part) => part !== "")
    .join(". ")
    .slice(0, TEXT_MAX_CHARS);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Cosine similarity of two vectors of the same length. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.at(index) ?? 0;
    const y = b.at(index) ?? 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right);
}

/** The moments that answer a question, best first (see {@link SEARCH_MIN_SCORE}). */
export function matchesOf(scored: readonly RunSearchMatch[]): RunSearchMatch[] {
  if (scored.length === 0) return [];
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const best = ranked.at(0)?.score ?? 0;
  const ascending = ranked.map((entry) => entry.score).reverse();
  const median = ascending.at(Math.floor((ascending.length - 1) / 2)) ?? 0;
  if (best < SEARCH_MIN_SCORE || (ranked.length > 2 && best - median < SEARCH_MIN_LEAD)) return [];
  const floor = Math.max(SEARCH_MIN_SCORE, best - SEARCH_BAND);
  return ranked.filter((entry) => entry.score >= floor).slice(0, SEARCH_MAX_MATCHES);
}

/** The Ollama server's root, from the OpenAI-compatible `LLM_BASE_URL` (`.../v1`). */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Whether `url` is this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function vectorKey(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${redisKeyPrefix()}:repurpose:embed:v1:${SEARCH_EMBED_MODEL}:${hash}`;
}

function encode(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

function decode(raw: string): number[] {
  const bytes = Buffer.from(raw, "base64");
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4));
}

@Injectable()
export class RunSearch {
  private readonly logger = new Logger(RunSearch.name);
  /** A field so a test can answer for Ollama. */
  embedder: (texts: readonly string[]) => Promise<number[][]> = (texts) => this.embedLocally(texts);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The run's moments closest in meaning to `query`, best first. The caller checks the run is the workspace's. */
  async search(runId: string, query: string): Promise<RunSearchResult> {
    const question = query.trim();
    if (question === "") return { semantic: true, matches: [] };
    const rows = await this.prisma.clipCandidate.findMany({
      where: { runId, state: { not: "rejected" } },
      select: { id: true, title: true, transcriptExcerpt: true, copy: true, judgement: true },
    });
    if (rows.length === 0) return { semantic: true, matches: [] };
    const moments: MomentText[] = rows.map((row) => ({ id: row.id, text: momentText(row) }));

    let vectors: Map<string, number[]>;
    try {
      vectors = await this.vectorsOf([question, ...moments.map((moment) => moment.text)]);
    } catch (error) {
      this.logger.warn(
        { runId, err: error instanceof Error ? error.message : String(error) },
        "clip search by meaning is unavailable; the page keeps its word match",
      );
      return { semantic: false, matches: [] };
    }
    const asked = vectors.get(question);
    if (asked === undefined) return { semantic: false, matches: [] };
    const scored = moments.flatMap((moment) => {
      const vector = vectors.get(moment.text);
      return vector === undefined
        ? []
        : [{ candidateId: moment.id, score: Math.round(cosine(asked, vector) * 1000) / 1000 }];
    });
    return { semantic: true, matches: matchesOf(scored) };
  }

  /** A vector for each text: from the cache, else from the model (then cached). */
  private async vectorsOf(texts: readonly string[]): Promise<Map<string, number[]>> {
    const unique = [...new Set(texts)];
    const cached = await this.redis.client.mget(...unique.map(vectorKey));
    const out = new Map<string, number[]>();
    const missing: string[] = [];
    unique.forEach((content, index) => {
      const raw = cached.at(index);
      if (typeof raw === "string" && raw !== "") out.set(content, decode(raw));
      else missing.push(content);
    });
    if (missing.length > 0) {
      const fresh = await this.embedder(missing);
      if (fresh.length !== missing.length)
        throw new Error("the model answered for a different number of texts");
      const pipeline = this.redis.client.multi();
      missing.forEach((content, index) => {
        const vector = fresh.at(index) ?? [];
        out.set(content, vector);
        pipeline.set(vectorKey(content), encode(vector), "EX", VECTOR_TTL_SECONDS);
      });
      await pipeline.exec();
    }
    return out;
  }

  private async embedLocally(texts: readonly string[]): Promise<number[][]> {
    const root = ollamaRoot(this.env.LLM_BASE_URL);
    // What is said in a video never leaves this machine for a search: a
    // `LLM_BASE_URL` that is not local (a hosted provider's) is not asked.
    if (!isLoopback(root)) throw new Error("no local embedding server is configured");
    const response = await fetch(`${root}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: SEARCH_EMBED_MODEL,
        input: texts,
        truncate: true,
        keep_alive: EMBED_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the embedding model answered ${String(response.status)}`);
    const body = (await response.json()) as { embeddings?: unknown };
    if (!Array.isArray(body.embeddings)) throw new Error("the embedding model sent no vectors");
    return body.embeddings.map((vector) =>
      Array.isArray(vector)
        ? vector.filter((value): value is number => typeof value === "number")
        : [],
    );
  }
}
