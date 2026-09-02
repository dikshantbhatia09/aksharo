import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  CreateMemoryEntryDto,
  createMemoryEntrySchema,
  ImportGlossaryDto,
  importGlossaryResultSchema,
  importGlossarySchema,
  memoryEntryResponseSchema,
  MEMORY_KINDS,
  SpellingFixHookDto,
  spellingFixHookSchema,
  StylePrefHookDto,
  stylePrefHookSchema,
  TimingNudgeHookDto,
  timingNudgeHookSchema,
  UpdateMemoryEntryDto,
  updateMemoryEntrySchema,
} from "./memory.dto.js";
import { type ImportResult, type MemoryEntryView, MemoryService } from "./memory.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, RolesGuard } from "../common/guards/index.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/memory` — Settings → "What Aksharo learned" (F-204, D62).
 *
 * Every route requires the `memory` consent; `MemoryService` re-checks it on
 * every mutation rather than trusting a cached flag (see its docstring).
 */
@ApiTags("memory")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@Controller("memory")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's workspace's memory entries",
    operationId: "listMemory",
  })
  @ApiOkResponse(zodResponse(memoryEntryResponseSchema, "Memory entries."))
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Query("kind") kind?: string,
  ): Promise<readonly MemoryEntryView[]> {
    if (kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(kind)) return [];
    return this.memory.list(principal.workspaceId, kind);
  }

  @Post()
  @ApiOperation({ summary: "Create or merge a memory entry", operationId: "createMemory" })
  @ApiBody(zodBody(createMemoryEntrySchema))
  @ApiOkResponse(zodResponse(memoryEntryResponseSchema, "The stored entry."))
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: CreateMemoryEntryDto,
  ): Promise<MemoryEntryView> {
    return this.memory.upsert(principal.workspaceId, principal.userId, body);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit one memory entry", operationId: "updateMemory" })
  @ApiBody(zodBody(updateMemoryEntrySchema))
  @ApiOkResponse(zodResponse(memoryEntryResponseSchema, "The updated entry."))
  async update(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") id: string,
    @Body() body: UpdateMemoryEntryDto,
  ): Promise<MemoryEntryView> {
    return this.memory.update(principal.workspaceId, principal.userId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete one memory entry", operationId: "deleteMemoryEntry" })
  async remove(@CurrentUser() principal: AuthPrincipal, @Param("id") id: string): Promise<void> {
    await this.memory.remove(principal.workspaceId, principal.userId, id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Clear every memory entry for the workspace", operationId: "clearMemory" })
  async clear(@CurrentUser() principal: AuthPrincipal): Promise<void> {
    await this.memory.clearAll(principal.workspaceId, principal.userId);
  }

  @Post("import")
  @ApiOperation({ summary: "Bulk-import glossary terms from CSV", operationId: "importMemoryGlossary" })
  @ApiBody(zodBody(importGlossarySchema))
  @ApiOkResponse(zodResponse(importGlossaryResultSchema, "Import counts."))
  async import(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ImportGlossaryDto,
  ): Promise<ImportResult> {
    return this.memory.importGlossary(principal.workspaceId, principal.userId, body.csv);
  }

  // --- Learning hooks (brief §2) -------------------------------------------

  @Post("hooks/spelling-fix")
  @ApiOperation({
    summary: "A15's 'Fix spelling everywhere' hook",
    description: "Records the correction as a `spelling` memory entry (script-aware).",
    operationId: "recordSpellingFixMemory",
  })
  @ApiBody(zodBody(spellingFixHookSchema))
  async spellingFix(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SpellingFixHookDto,
  ): Promise<MemoryEntryView | undefined> {
    return this.memory.recordSpellingFix(
      principal.workspaceId,
      principal.userId,
      body.wrong,
      body.right,
      body.script,
    );
  }

  @Post("hooks/timing-nudge")
  @ApiOperation({
    summary: "A17/A02d timing-nudge sink feed",
    description: "One drag delta (ms); rolled into a per-workspace median caption offset.",
    operationId: "recordTimingNudgeMemory",
  })
  @ApiBody(zodBody(timingNudgeHookSchema))
  async timingNudge(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: TimingNudgeHookDto,
  ): Promise<MemoryEntryView> {
    return this.memory.recordTimingNudge(principal.workspaceId, principal.userId, body.deltaMs);
  }

  @Post("hooks/style-pref")
  @ApiOperation({ summary: "Last style/template used per aspect", operationId: "recordStylePrefMemory" })
  @ApiBody(zodBody(stylePrefHookSchema))
  async stylePref(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: StylePrefHookDto,
  ): Promise<MemoryEntryView> {
    return this.memory.recordStylePreference(
      principal.workspaceId,
      principal.userId,
      body.aspect,
      body.styleId,
    );
  }
}
