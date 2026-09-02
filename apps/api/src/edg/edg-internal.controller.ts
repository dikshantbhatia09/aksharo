import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { InternalOpBatchRequestDto, type OpBatchResponseDto } from "./edg.dto.js";
import { EdgService } from "./edg.service.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";

/**
 * `POST /internal/projects/{id}/edg/ops` — the worker's write path.
 *
 * `MergePass` is worker-only (CONTRACTS §2; the engine answers `forbidden` to
 * anyone else), and "worker" cannot be a claim in a user's token: a browser that
 * could ask for `source: "worker"` could land an arbitrary pass with arbitrary
 * licence snapshots in somebody's document. So the only route that submits ops as
 * `worker` is this one, and the only way through it is
 * {@link InternalSignatureGuard} — the HMAC of CONTRACTS §3 over the exact request
 * bytes (THREAT-MODEL T8).
 *
 * It is otherwise the same write path as the public one: the same transaction,
 * the same rebase, the same realtime echo. The workspace budget does not apply —
 * a pass merge is admitted by A08's job admission control long before it gets
 * here, and rate-limiting it would drop finished work.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/projects/:projectId/edg")
export class EdgInternalController {
  constructor(private readonly edg: EdgService) {}

  @Post("ops")
  @HttpCode(HttpStatus.OK)
  async ops(
    @Param("projectId") projectId: string,
    @Body() body: InternalOpBatchRequestDto,
  ): Promise<OpBatchResponseDto> {
    return this.edg.applyWorkerOps({
      projectId,
      baseRevision: body.baseRevision,
      ops: body.ops,
      clientOpIds: body.clientOpIds,
    });
  }
}
