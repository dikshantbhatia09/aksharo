import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  AvailableScriptsDto,
  TransliterateAcceptedDto,
  TransliterateRequestDto,
  TranslateAcceptedDto,
  TranslateRequestDto,
} from "./scripts.dto.js";
import { ScriptsService } from "./scripts.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../../common/guards/index.js";

/**
 * Scripts and translation: `POST .../transliterate`, `POST .../translate`,
 * `GET .../scripts` (A22).
 *
 * `@Roles("editor")` on the two producers for the same reason `transcribe` is:
 * both spend the workspace's time (transliteration) or credits (translation),
 * so a viewer reads the result and does not commission it. A project in
 * another workspace is a 404, not a 403 (THREAT-MODEL T4, T5) —
 * `ScriptsService` enforces it the same way `TranscriptsService` does.
 */
@ApiTags("transcripts")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`, or `transcript/not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/transcript")
export class ScriptsController {
  constructor(private readonly scriptsService: ScriptsService) {}

  @Post("transliterate")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Transliterate the transcript into a script",
    description:
      "Free (`04 §Credits`). Enqueues `ai.transliterate`, which writes per-word `scripts` " +
      "variants — Hinglish stays Roman-first, English words are preserved — and never " +
      "touches `t`, timings or a script the user has already edited via `textOverrides`.",
    operationId: "transliterateProjectTranscript",
  })
  @ApiOkResponse({ type: TransliterateAcceptedDto, description: "Accepted and queued." })
  async transliterate(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: TransliterateRequestDto,
  ): Promise<TransliterateAcceptedDto> {
    return this.scriptsService.transliterate({
      projectId,
      workspaceId: principal.workspaceId,
      script: body.script,
    });
  }

  @Post("translate")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Translate the transcript's captions",
    description:
      "0.5 credit per media minute per target language (`04 §Credits`); English on " +
      "Starter+, every language on Creator+. One `ai.translate` job per target, each " +
      "held and quoted on its own. The result lands as `textOverrides.translated` " +
      "through the ordinary EDG op path, so it is revisioned and undoable, and a " +
      "concurrent edit to the same segment's `translated` text comes back as a 409 the " +
      "job reports as failed rather than a silent overwrite.",
    operationId: "translateProjectTranscript",
  })
  @ApiOkResponse({ type: TranslateAcceptedDto, description: "Accepted and queued." })
  @ApiPaymentRequiredResponse({ description: "`transcript/plan_required`." })
  async translate(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: TranslateRequestDto,
  ): Promise<TranslateAcceptedDto> {
    const accepted = await this.scriptsService.translate({
      projectId,
      workspaceId: principal.workspaceId,
      targets: body.targets,
    });
    return { targets: [...accepted.targets], quote: accepted.quote };
  }

  @Get("scripts")
  @Roles("viewer")
  @ApiOperation({
    summary: "Which scripts this transcript has, and where they came from",
    description:
      "`roman` / `native` / `en` come from the words themselves; `translated` from the " +
      "editing document's segment overrides. Each carries the job that produced it when " +
      'one is known, for the editor\'s script tabs and the "regenerate" confirmation.',
    operationId: "getProjectTranscriptScripts",
  })
  @ApiOkResponse({ type: AvailableScriptsDto })
  async scripts(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<AvailableScriptsDto> {
    const scripts = await this.scriptsService.availableScripts(projectId, principal.workspaceId);
    return { scripts: [...scripts] };
  }
}
