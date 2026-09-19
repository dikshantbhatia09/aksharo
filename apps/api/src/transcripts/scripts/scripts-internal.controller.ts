import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import type { Word } from "@montaj/edg/schemas";

import { InternalScriptsWriteDto } from "./scripts.dto.js";
import { ScriptsService } from "./scripts.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { newestChunkRows } from "../../edg/chunk-rows.js";
import { InternalSignatureGuard } from "../../internal/internal-signature.guard.js";

import type { InternalScriptsWriteAck } from "./scripts.dto.js";

/**
 * `POST /internal/transcripts/{id}/scripts` — the worker's transliteration
 * write path (A22).
 *
 * The counterpart to `EdgInternalController` for a fact translation does not
 * share with it: there is no `EdgOp` for "merge these per-word script
 * variants" (CONTRACTS §2's `EdgOp` union is closed, and adding one for a
 * potentially thousand-word bulk write would mean either a thousand `EditWord`
 * ops per transliteration or a new frozen interface for one work package to
 * open — raised, not taken). So this is its own small signed surface, guarded
 * by the same {@link InternalSignatureGuard} (THREAT-MODEL T8) as every other
 * `/internal/**` route, writing directly to `transcript_chunks` the way
 * `PATCH /internal/media/{id}` writes directly to `media_assets`.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/transcripts/:transcriptId")
export class ScriptsInternalController {
  constructor(
    private readonly scripts: ScriptsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("scripts")
  @HttpCode(HttpStatus.OK)
  async writeScripts(
    @Param("transcriptId") transcriptId: string,
    @Body() body: InternalScriptsWriteDto,
  ): Promise<InternalScriptsWriteAck> {
    return this.scripts.applyWordScripts({
      transcriptId,
      jobId: body.jobId,
      targetScript: body.targetScript,
      provider: body.provider,
      words: body.words,
    });
  }

  @Post("words")
  @HttpCode(HttpStatus.OK)
  async getWords(@Param("transcriptId") transcriptId: string, @Body() body: { revision?: number }) {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, projectId: true, currentRevision: true, language: true },
    });
    if (!transcript) {
      return { transcriptId, revision: 1, words: [], durationMs: 0 };
    }
    const revision = body?.revision ?? transcript.currentRevision;
    const chunkRows = await newestChunkRows(this.prisma, transcriptId, { maxRevision: revision });
    const words: Array<{
      wid: string;
      text: string;
      startMs: number;
      endMs: number;
      chunkIdx: number;
    }> = [];
    for (const chunk of chunkRows) {
      const chunkWords = (chunk.words as unknown as Word[] | null) ?? [];
      for (const w of chunkWords) {
        if (!w.deleted) {
          words.push({
            wid: w.wid,
            text: w.t,
            startMs: w.s,
            endMs: w.e,
            chunkIdx: chunk.chunkIdx,
          });
        }
      }
    }
    const lastWord = words.length > 0 ? words[words.length - 1] : undefined;
    const durationMs = lastWord ? lastWord.endMs : 0;
    return {
      transcriptId,
      projectId: transcript.projectId,
      revision,
      durationMs,
      words,
    };
  }
}
