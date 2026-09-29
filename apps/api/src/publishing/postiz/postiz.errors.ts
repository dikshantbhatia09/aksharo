/**
 * Every way a call to Postiz can go wrong, as one of a dozen kinds.
 *
 * The kind is what callers branch on; `detail` is Postiz's own message, kept
 * for the log line and for recognising a known refusal - never shown to a
 * person, who gets one of `publish-dispatcher.ts`'s sentences instead.
 *
 * `uncertain` is the one that matters most (master plan §4.3): the request may
 * have reached Postiz and been acted on, so the only legal next step for a
 * post is to ask Postiz what happened, never to send it again.
 */
export type PostizErrorKind =
  /** No key, or a URL this API refuses to send the key to. Nothing was sent. */
  | "not_configured"
  /** Could not connect at all (refused, unknown host, breaker open). Nothing was sent. */
  | "unreachable"
  /** 401: the key was refused. */
  | "unauthorized"
  /** 403: the key is valid but not allowed this. */
  | "forbidden"
  /** 429: Postiz's own limit (`API_LIMIT` posts an hour); `retryAfterMs` says when. */
  | "rate_limited"
  /** 400/422: Postiz refused what was sent; sending it again gets the same answer. */
  | "bad_request"
  /** 413: the body was too large. */
  | "too_large"
  /** 404. */
  | "not_found"
  /** 5xx: Postiz failed while handling it; it may or may not have acted. */
  | "server"
  /** The connection broke after the request may have been sent. */
  | "network"
  /** No answer within the deadline. */
  | "timeout"
  /** A success status with a body that does not parse. */
  | "malformed";

const UNCERTAIN: ReadonlySet<PostizErrorKind> = new Set([
  "server",
  "network",
  "timeout",
  "malformed",
]);

export class PostizError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly detail: string | null;

  constructor(
    readonly kind: PostizErrorKind,
    message: string,
    options: {
      readonly status?: number | null;
      readonly retryAfterMs?: number | null;
      readonly detail?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "PostizError";
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ?? null;
  }

  /** The request may have been acted on: reconcile before any resend. */
  get uncertain(): boolean {
    return UNCERTAIN.has(this.kind);
  }

  /** Worth trying again later with the same input (a pass, not a refusal). */
  get transient(): boolean {
    return (
      this.kind === "unreachable" ||
      this.kind === "rate_limited" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout"
    );
  }
}

export function isPostizError(value: unknown): value is PostizError {
  return value instanceof PostizError;
}
