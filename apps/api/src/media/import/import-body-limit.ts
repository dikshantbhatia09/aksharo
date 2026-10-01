import { HttpStatus } from "@nestjs/common";
import { json } from "express";

import { AppException } from "../../common/errors/error-codes.js";
import { IMPORT_ERRORS, IMPORT_MAX_BYTES } from "../../projects/projects.constants.js";

import type { INestApplication, RawBodyRequest } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * The JSON body limit for the two routes that carry a whole subtitle file inline
 * (2026-10-01, the review of "start a clips run with your own captions").
 *
 * `POST /repurpose/runs` (`setup.captions.content`) and the editor's
 * `POST /projects/:projectId/import` (`content`) both promise a caption file of
 * up to {@link IMPORT_MAX_BYTES} (2 MB) — the cap `SubtitleImportService.prepareInline`
 * enforces with a readable `413 import/too_large`. But Express's default JSON
 * parser stops at 100 kB, so before this every file over roughly 100 kB was
 * refused by `body-parser` before zod or `prepareInline` ever saw it: a
 * 90-minute English podcast's SRT, or about an hour of Devanagari (three bytes a
 * character in UTF-8). And `body-parser`'s refusal is a plain `Error`, so the
 * CONTRACTS §8 filter answered it as `500 common/internal`. The editor's import
 * had the same gap from the start; the clips form made it everyone's problem by
 * advertising 2 MB to every clips user.
 *
 * **Why 3 MB and not 2.** The file travels as a JSON *string*: every newline is
 * `\n` (two bytes), every quote `\"`, and an SRT is mostly short lines, so a 2 MB
 * file with Windows line ends grows by about a tenth once encoded, plus the rest
 * of the run's setup. 3 MB leaves room for that and nothing much more; the 2 MB
 * check on the decoded text is still the one that decides.
 *
 * **Why only these two routes, and only their exact POST.** The limit is a
 * resource control (THREAT-MODEL T8): the parser runs before any guard, so a
 * raised limit is heap an anonymous caller can make the API hold. Every other
 * route — including everything under `/repurpose/runs/:runId/...` — keeps the
 * adapter's 100 kB parser, because this wrapper hands any other method or path
 * straight on without parsing it.
 *
 * The shape (a named wrapper, registered before `app.init()`, with a `verify`
 * that keeps `rawBody`) is `internal/internal-body-limit.ts`'s, for the same two
 * reasons it documents: the first parser to set `req._body` wins, and a layer
 * named `jsonParser` would stop the adapter registering its global one.
 */

/** As a `body-parser` size string. */
export const IMPORT_BODY_LIMIT = "3mb";

/** The same figure in bytes, for tests. */
export const IMPORT_BODY_LIMIT_BYTES = 3 * 1024 * 1024;

/** Mount paths. Express matches `app.use` paths as prefixes; see {@link isExactPost}. */
export const IMPORT_BODY_PATHS = ["/repurpose/runs", "/projects/:projectId/import"] as const;

export function applyImportBodyLimit(app: INestApplication): void {
  const parse = json({
    limit: IMPORT_BODY_LIMIT,
    verify: (request: Request, _response: Response, buffer: Buffer) => {
      if (Buffer.isBuffer(buffer)) (request as RawBodyRequest<Request>).rawBody = buffer;
    },
  });

  // Named, and deliberately not `jsonParser` (see internal-body-limit.ts).
  const importJsonBodyParser = (request: Request, response: Response, next: NextFunction) => {
    if (!isExactPost(request)) {
      next();
      return;
    }
    parse(request, response, (error?: unknown) => {
      next(isTooLarge(error) ? tooLarge() : error);
    });
  };
  for (const path of IMPORT_BODY_PATHS) app.use(path, importJsonBodyParser);
}

/**
 * Only the mounted path itself: `app.use("/repurpose/runs")` also matches
 * `/repurpose/runs/:runId/cancel`, and inside the middleware `req.path` is what
 * is left after the mount point, so `/` (or empty) means the route itself.
 */
function isExactPost(request: Request): boolean {
  return request.method === "POST" && (request.path === "/" || request.path === "");
}

/** `body-parser` refuses an oversized body with a plain `Error`; see internal-body-limit.ts. */
function isTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  return record.type === "entity.too.large" || record.status === 413 || record.statusCode === 413;
}

/** The same code and words `prepareInline` uses, so the web shows one message for both. */
function tooLarge(): AppException {
  return new AppException(
    IMPORT_ERRORS.tooLarge,
    `A subtitle import may be at most ${String(IMPORT_MAX_BYTES / (1024 * 1024))} MB.`,
    HttpStatus.PAYLOAD_TOO_LARGE,
    { maxBytes: IMPORT_MAX_BYTES },
  );
}
