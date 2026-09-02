import { Injectable, type NestMiddleware } from "@nestjs/common";

import type { NextFunction, Request, Response } from "express";

/** A body larger than this is not an SNS message; SNS caps a payload at 256 KB. */
export const MAX_SNS_BODY_BYTES = 256 * 1024;

/**
 * Buffer and parse the body of `POST /internal/mail/events`.
 *
 * Amazon SNS posts `Content-Type: text/plain; charset=UTF-8` — it has done since
 * the service launched and it is not configurable — so Nest's JSON body parser
 * skips the request entirely and the handler would see `{}`. Rather than widen
 * the global parser to treat every `text/plain` request as JSON, which would
 * change how the whole API reads bodies for one route, this middleware is applied
 * to that one path.
 *
 * It gives up on anything the global parser already handled (a client that
 * correctly sends `application/json`), caps the read so an endpoint with no
 * authentication in front of it cannot be used to buffer megabytes, and leaves an
 * unparseable body as `undefined` for the controller to reject.
 */
@Injectable()
export class SnsBodyMiddleware implements NestMiddleware {
  use(request: Request, _response: Response, next: NextFunction): void {
    const existing: unknown = request.body;
    if (existing !== undefined && existing !== null && typeof existing === "object") {
      if (Object.keys(existing as Record<string, unknown>).length > 0) {
        next();
        return;
      }
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const done = (): void => {
      if (finished) return;
      finished = true;
      next();
    };

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SNS_BODY_BYTES) {
        chunks.length = 0;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        request.body = JSON.parse(text) as unknown;
      } catch {
        request.body = undefined;
      }
      done();
    });

    request.on("error", done);
  }
}
