import { PayloadTooLargeException } from "@nestjs/common";
import { json } from "express";

import type { RawBodyRequest, INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * The `/internal/**` JSON body limit (A11).
 *
 * Express's default is 100 kB, which is right for every request a browser makes
 * and far too small for the one thing a worker sends: an `ai.transcribe`
 * completion carries the whole transcript in `result.chunks`. A 60-minute
 * interview is roughly 9 000 words, each a `{wid, s, e, t, c, sp, scripts}`
 * object with a Devanagari and a Roman spelling — about 4 MB of JSON, and a
 * three-hour recording with two scripts and per-word confidences runs several
 * times that. 32 MB is the ceiling the queue timeouts and the 10-minute chunk
 * plan (D14) make reachable; anything larger is a bug in the worker, not a long
 * podcast, and is refused with `common/payload_too_large`.
 *
 * **Only `/internal`.** The limit is a resource control (THREAT-MODEL T8): the
 * signed surface is reachable by a caller holding `INTERNAL_CALLBACK_SECRET` and
 * nobody else, whereas raising it globally would let any anonymous request tie up
 * 32 MB of heap before a guard ever ran.
 *
 * ### Why a wrapper function rather than `express.json()` directly
 *
 * Two details of the platform adapter decide the shape of this:
 *
 * 1. **It must run before Nest's own parser.** `body-parser` skips a request
 *    whose `req._body` is already set, so the first parser to see `/internal`
 *    wins and Nest's 100 kB one becomes a no-op for those routes. That means
 *    calling this **before `app.init()`**, which is when the adapter registers
 *    its parsers.
 * 2. **It must not look like Nest's parser.** `ExpressAdapter.registerParserMiddleware`
 *    skips its own registration when a layer named `jsonParser` is already on the
 *    stack — and `express.json()` returns a function called exactly that. Handing
 *    it a differently named wrapper keeps the global parser, so every other route
 *    still gets a body.
 *
 * The `verify` hook reproduces what `{ rawBody: true }` does for the adapter's
 * parser: the HMAC of CONTRACTS §3 covers the bytes as sent, and a re-serialised
 * body would not reproduce a Python worker's signature.
 */

/** 32 MB, as a `body-parser` size string. */
export const INTERNAL_BODY_LIMIT = "32mb";

/** The same figure in bytes, for tests and for anything that has to compare. */
export const INTERNAL_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** Path prefix the raised limit applies to. */
export const INTERNAL_PATH_PREFIX = "/internal";

export function applyInternalBodyLimit(app: INestApplication): void {
  const parse = json({
    limit: INTERNAL_BODY_LIMIT,
    verify: (request: Request, _response: Response, buffer: Buffer) => {
      if (Buffer.isBuffer(buffer)) (request as RawBodyRequest<Request>).rawBody = buffer;
    },
  });

  // Named, and deliberately not `jsonParser` — see the note above.
  app.use(
    INTERNAL_PATH_PREFIX,
    function internalJsonBodyParser(request: Request, response: Response, next: NextFunction) {
      parse(request, response, (error?: unknown) => {
        next(isTooLarge(error) ? tooLarge() : error);
      });
    },
  );
}

/**
 * `body-parser` rejects an oversized body with a **plain `Error`** carrying
 * `type: "entity.too.large"` and a `status` property — not a Nest exception — so
 * without this translation the CONTRACTS §8 filter sees an unrecognised throwable
 * and answers `500 common/internal`. A worker that sent too much deserves to be
 * told exactly that, and 413 is the only status it can act on.
 */
function isTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  return record.type === "entity.too.large" || record.status === 413 || record.statusCode === 413;
}

function tooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException(
    `The request body is larger than the ${INTERNAL_BODY_LIMIT} limit for /internal.`,
  );
}
