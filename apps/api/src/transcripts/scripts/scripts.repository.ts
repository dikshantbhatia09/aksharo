import { Injectable, Logger } from "@nestjs/common";

import type { ScriptId, Word } from "@montaj/edg/schemas";

import { type PrismaTransaction, PrismaService } from "../../common/prisma/prisma.service.js";

import type { Prisma } from "@prisma/client";

/** One word's new text for a script slot, as the internal write carries it. */
export interface ScriptWordInput {
  readonly wid: string;
  readonly text: string;
}

export interface ApplyWordScriptsInput {
  readonly transcriptId: string;
  readonly targetScript: "roman" | "native";
  readonly words: readonly ScriptWordInput[];
}

export interface ApplyWordScriptsResult {
  readonly projectId: string;
  readonly revision: number;
  readonly wordsUpdated: number;
}

type ChunkRow = { id: string; chunkIdx: number; words: Prisma.JsonValue };

/**
 * The write side of `word.scripts` (A22's `POST /internal/transcripts/{id}/scripts`).
 *
 * Patches **only** the `transcript_chunks` rows a transliteration actually
 * touched, merging `scripts[targetScript]` into each named word and leaving
 * every other field — `t`, `s`, `e`, `sp`, `filler`, `deleted` — exactly as it
 * was. This mirrors `EdgRepository.persistWords` (A12): word edits are an
 * `UPDATE` of the row a word already lives in, never a new revision's worth of
 * rows, because word ids are addressed by `(chunkIdx, n)` and every chunk keeps
 * its own row.
 *
 * ### `transcripts.currentRevision` is deliberately **not** touched here
 *
 * `EdgRepository.persistWords` bumps it on every `EditWord`, and this write is
 * the same shape of change — but `TranscriptsRepository.chunkPage`/`allChunks`
 * (`GET /projects/{id}/transcript`, the exporters) select
 * `transcript_chunks` by an **exact** `revision` match, which is right for "a
 * named revision" (a full re-transcription writes a second generation of rows
 * at `revision + 1`) and wrong for an in-place `UPDATE` that never changes the
 * row's own `revision` column at all. A caller that reads the default revision
 * (`transcript.currentRevision`) after `persistWords` has advanced it past the
 * chunk rows' own value gets an empty page — a **pre-existing gap between
 * A11's chunk-read contract and A12's word-patch contract**, reachable today
 * through an ordinary `EditWord` op followed by `GET /transcript` with no
 * `revision` pinned. This method avoids adding a second way to hit it: the
 * write is visible on the very next read at the **same** revision the caller
 * was already using, because the row it updated never changed which revision
 * it belongs to. Reported to the orchestrator rather than fixed here — the fix
 * belongs to whichever of A11/A12 owns resolving it, not to a work package
 * extending a third feature on top of both.
 */
@Injectable()
export class ScriptsRepository {
  private readonly logger = new Logger(ScriptsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async applyWordScripts(input: ApplyWordScriptsInput): Promise<ApplyWordScriptsResult> {
    const byChunk = groupByChunk(input.words);

    return this.prisma.withTransaction(
      async (tx) => {
        const transcript = await tx.transcript.findUnique({
          where: { id: input.transcriptId },
          select: { id: true, projectId: true, currentRevision: true },
        });
        if (transcript === null) {
          throw new TranscriptNotFoundError(input.transcriptId);
        }

        const rows = await this.newestChunkRows(tx, input.transcriptId, [...byChunk.keys()]);

        let changed = 0;
        for (const [chunkIdx, patch] of byChunk) {
          const row = rows.get(chunkIdx);
          if (row === undefined) continue; // no such chunk on this transcript; skip, don't fail the batch
          const words = (row.words as unknown as Word[] | null) ?? [];
          const { words: merged, changedCount } = mergeScripts(words, patch, input.targetScript);
          if (changedCount === 0) continue; // nothing in this chunk actually changed
          await tx.transcriptChunk.update({
            where: { id: row.id },
            data: { words: merged as unknown as Prisma.InputJsonValue },
          });
          changed += changedCount;
        }

        if (changed > 0) {
          await this.mirrorIntoEdgDocument(
            tx,
            transcript.projectId,
            input.targetScript,
            transcript.currentRevision,
          );
        }

        return {
          projectId: transcript.projectId,
          revision: transcript.currentRevision,
          wordsUpdated: changed,
        };
      },
      { timeoutMs: 30_000, maxWaitMs: 10_000 },
    );
  }

  /** Chunk rows, newest revision per `chunkIdx` — the same read A12's EDG repository does. */
  private async newestChunkRows(
    tx: PrismaTransaction,
    transcriptId: string,
    chunkIdxs: readonly number[],
  ): Promise<Map<number, ChunkRow>> {
    if (chunkIdxs.length === 0) return new Map();
    const rows = await tx.transcriptChunk.findMany({
      where: { transcriptId, chunkIdx: { in: [...chunkIdxs] } },
      orderBy: [{ chunkIdx: "asc" }, { revision: "desc" }],
      select: { id: true, chunkIdx: true, words: true },
    });
    const newest = new Map<number, ChunkRow>();
    for (const row of rows) if (!newest.has(row.chunkIdx)) newest.set(row.chunkIdx, row);
    return newest;
  }

  /**
   * Add `targetScript` to `EdgHot.transcript.scripts` (and keep
   * `EdgHot.transcript.revision` mirroring `transcripts.currentRevision`,
   * which this write does not change — see the class doc above), when a
   * document exists.
   *
   * Best-effort and outside any compare-and-swap on `edg_documents.revision`:
   * this is the same category of update as `engineVersions` (`edg/README.md`
   * §`EdgService.initialise`) — descriptive metadata about what produced the
   * document, not a change to its segments or passes, so it does not need the
   * op log's conflict machinery. A concurrent op batch racing this update can
   * overwrite it; the next transliteration (or the next `initialise`) mirrors
   * it again, so a lost update self-heals rather than corrupting anything.
   */
  private async mirrorIntoEdgDocument(
    tx: PrismaTransaction,
    projectId: string,
    targetScript: ScriptId,
    transcriptRevision: number,
  ): Promise<void> {
    const document = await tx.edgDocument.findUnique({
      where: { projectId },
      select: { id: true, doc: true },
    });
    if (document === null) return; // transcribed but never opened; nothing to mirror into

    const hot = document.doc as unknown as {
      transcript?: { scripts?: string[]; revision?: number; [key: string]: unknown };
      [key: string]: unknown;
    };
    const currentScripts = Array.isArray(hot.transcript?.scripts) ? hot.transcript.scripts : [];
    const scripts = currentScripts.includes(targetScript)
      ? currentScripts
      : [...currentScripts, targetScript];

    await tx.edgDocument.update({
      where: { id: document.id },
      data: {
        doc: {
          ...hot,
          transcript: { ...hot.transcript, scripts, revision: transcriptRevision },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Record which BCP-47 language `textOverrides.translated` currently holds
   * (A22 brief: "a language tag recorded on the EDG meta") — called by
   * `TranslateCompletionHandler` after the worker's `SetSegmentText` batch has
   * already landed through the ordinary op-log write path.
   *
   * `EdgHot.meta.engineVersions` is `Record<string, string>` by contract
   * (CONTRACTS §2) and is already how A11 records the caption budgets it
   * segmented with — the document's own note of *what produced it*, read by
   * nothing inside `packages/edg`. Best-effort for the same reason
   * {@link mirrorIntoEdgDocument} is: this is metadata, not a document
   * revision, so a lost update against a concurrent op batch self-heals on the
   * next translate job rather than corrupting anything.
   */
  async setTranslationLanguage(projectId: string, language: string): Promise<void> {
    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true, doc: true },
    });
    if (document === null) return;

    const hot = document.doc as unknown as {
      meta?: { engineVersions?: Record<string, string>; [key: string]: unknown };
      [key: string]: unknown;
    };
    const engineVersions = { ...hot.meta?.engineVersions, translationLanguage: language };

    await this.prisma.edgDocument.update({
      where: { id: document.id },
      data: {
        doc: {
          ...hot,
          meta: { ...hot.meta, engineVersions },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

export class TranscriptNotFoundError extends Error {
  constructor(readonly transcriptId: string) {
    super(`no such transcript: ${transcriptId}`);
  }
}

/** Group `(wid, text)` pairs by the chunk their `wid` names. */
export function groupByChunk(words: readonly ScriptWordInput[]): Map<number, Map<string, string>> {
  const byChunk = new Map<number, Map<string, string>>();
  for (const word of words) {
    const chunkIdx = Number(word.wid.split(":")[0]);
    if (!Number.isFinite(chunkIdx)) continue;
    let patch = byChunk.get(chunkIdx);
    if (patch === undefined) {
      patch = new Map();
      byChunk.set(chunkIdx, patch);
    }
    patch.set(word.wid, word.text);
  }
  return byChunk;
}

/**
 * Merge `patch` into `words`, writing only `scripts[targetScript]`.
 *
 * Returns the **same array reference** when nothing changed, so the caller can
 * skip a write with a simple identity check rather than a deep comparison.
 */
export function mergeScripts(
  words: readonly Word[],
  patch: ReadonlyMap<string, string>,
  targetScript: "roman" | "native",
): { words: readonly Word[]; changedCount: number } {
  let changedCount = 0;
  const next = words.map((word) => {
    const text = patch.get(word.wid);
    if (text === undefined || word.scripts?.[targetScript] === text) return word;
    changedCount += 1;
    return { ...word, scripts: { ...word.scripts, [targetScript]: text } };
  });
  return { words: changedCount > 0 ? next : words, changedCount };
}
