import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { AUTOMATION_ERRORS } from "./source-watch.constants.js";
import { SourceWatchService } from "./source-watch.service.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import { RateLimitService } from "../../common/guards/rate-limit.service.js";
import { AppException } from "../../common/index.js";
import { REPURPOSE_ERRORS, REPURPOSE_RATE_LIMITS } from "../repurpose.constants.js";
import { RepurposeService, isRefusal } from "../repurpose.service.js";
import { SOURCE_REJECTION_MESSAGES, parseSourceUrl } from "../source-url.js";

import type { BulkRunResult, BulkRunsInput, BulkRunsResponse } from "./source-watch.dto.js";
import type { SourceRejectionCode } from "../source-url.js";

/**
 * "Several links" (2026-10-02): up to twenty YouTube links (and, since
 * 2026-10-01, Vimeo, Google Drive and Dropbox links), one run each, with
 * one setup - line by line, so one bad link never costs the others.
 *
 * Each link is exactly a start-form run: `parseSourceUrl` (a direct file link
 * is still refused, and so is anything that is not one video), then
 * `RepurposeService.create`, so credits, plan limits, windows, lanes, the
 * duplicate check and the YouTube gate apply to every one. Two links to the
 * same video are one run: the second line says so rather than asking twice.
 *
 * **The per-person ceiling holds.** A run started here spends a token from the
 * same `repurpose:create:user` bucket a single start does, so twenty links are
 * twenty starts, not one request's worth.
 *
 * **What stops the rest.** Out of credits, the plan's lanes full, the queue
 * down, the feature switched off, the hour's starts used up: each would refuse
 * every later link the same way, so those lines say it without being tried.
 * Every other refusal is that link's alone.
 */
@Injectable()
export class BulkRunsService {
  private readonly logger = new Logger(BulkRunsService.name);

  constructor(
    private readonly runs: RepurposeService,
    private readonly watches: SourceWatchService,
    private readonly limiter: RateLimitService,
    private readonly audit: CommonAuditService,
  ) {}

  async startMany(
    workspaceId: string,
    userId: string,
    input: BulkRunsInput,
  ): Promise<BulkRunsResponse> {
    await this.watches.assertAvailable(workspaceId);
    if (input.links.every((link) => link.trim() === "")) {
      throw new AppException(
        AUTOMATION_ERRORS.noLinks,
        "Paste at least one video link, one per line.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const results: BulkRunResult[] = [];
    const firstLine = new Map<string, number>();
    let halt: { readonly code: string; readonly message: string } | null = null;

    for (const [index, raw] of input.links.entries()) {
      const link = raw.trim();
      const refuse = (code: string, message: string): void => {
        results.push({ index, link, outcome: "refused", runId: null, code, message });
      };
      if (link === "") {
        refuse(REPURPOSE_ERRORS.sourceInvalidUrl, SOURCE_REJECTION_MESSAGES.not_a_url);
        continue;
      }
      const parsed = parseSourceUrl(link);
      if (!parsed.ok) {
        refuse(sourceCode(parsed.code), SOURCE_REJECTION_MESSAGES[parsed.code]);
        continue;
      }
      // A Vimeo, Google Drive or Dropbox link (2026-10-01) starts like a
      // YouTube one; `create` refuses it while that site is off for the
      // workspace, on its own line. A direct file link is still refused.
      if (parsed.source.kind === "direct_media_url") {
        refuse(
          REPURPOSE_ERRORS.sourceUnsupported,
          "Only video site links can be started together. Upload other videos as files.",
        );
        continue;
      }
      const earlier = firstLine.get(parsed.source.sourceFingerprint);
      if (earlier !== undefined) {
        results.push({
          index,
          link,
          outcome: "duplicate",
          runId: null,
          code: null,
          message: `The same video as line ${String(earlier + 1)}.`,
        });
        continue;
      }
      firstLine.set(parsed.source.sourceFingerprint, index);
      if (halt !== null) {
        refuse(halt.code, halt.message);
        continue;
      }

      const verdict = await this.limiter.consume(REPURPOSE_RATE_LIMITS.create, userId);
      if (!verdict.allowed) {
        halt = {
          code: ERROR_CODES.rateLimited,
          message: "You have started many runs in the last hour. Start the rest a little later.",
        };
        refuse(halt.code, halt.message);
        continue;
      }

      try {
        const created = await this.runs.create(workspaceId, userId, {
          source: { kind: "url", url: parsed.source.normalizedUrl, rightsAttested: true },
          setup: input.setup,
        });
        results.push({
          index,
          link,
          outcome: "started",
          runId: created.run.id,
          code: null,
          message: null,
        });
      } catch (error) {
        if (!(error instanceof AppException)) {
          this.logger.warn({ err: error, index }, "a run of a bulk start failed unexpectedly");
          refuse(ERROR_CODES.internal, "This one could not be started. Try it again on its own.");
          continue;
        }
        const existing = (error.details as { existingRunId?: unknown } | undefined)?.existingRunId;
        if (error.code === REPURPOSE_ERRORS.sourceDuplicate && typeof existing === "string") {
          results.push({
            index,
            link,
            outcome: "already_running",
            runId: existing,
            code: error.code,
            message: error.message,
          });
          continue;
        }
        refuse(error.code, error.message);
        if (
          error.code === REPURPOSE_ERRORS.noCredits ||
          error.httpStatus === HttpStatus.NOT_FOUND ||
          isRefusal(error)
        ) {
          halt = { code: error.code, message: error.message };
        }
      }
    }

    const started = results.filter((result) => result.outcome === "started");
    await this.audit.record({
      action: "repurpose.runs.bulk_started",
      resource: "repurpose_run",
      actorId: userId,
      workspaceId,
      // Run ids and outcomes only: the links themselves are not kept (§17.4).
      data: {
        links: input.links.length,
        started: started.map((result) => result.runId),
        outcomes: results.map((result) => result.outcome),
      },
    });
    return { results, started: started.length };
  }
}

function sourceCode(code: SourceRejectionCode): string {
  return code === "unsupported_source"
    ? REPURPOSE_ERRORS.sourceUnsupported
    : REPURPOSE_ERRORS.sourceInvalidUrl;
}
