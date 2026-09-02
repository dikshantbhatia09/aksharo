import { z } from "zod";

/**
 * The bridge wire protocol: JSON-RPC 2.0 (https://www.jsonrpc.org/specification)
 * carried over either the loopback WebSocket/HTTPS servers (`server.ts`) or the
 * relay tunnel (`relay-client.ts` + api `bridge-relay`). One schema set serves
 * both transports, so a method's shape never drifts between them.
 *
 * C01 brief §1. Methods are consumed by C06/C08 (apply transactions) and C02
 * (desktop shell) later; this package only defines and dispatches them.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Largest JSON-RPC message (request or response) accepted on either transport. */
export const MAX_MESSAGE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorShape = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Standard JSON-RPC error codes plus the bridge's own range (-32000..-32099). */
export const BRIDGE_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32000,
  forbidden: -32001,
  notPaired: -32002,
  pairingExpired: -32003,
  pairingDenied: -32004,
  rateLimited: -32005,
  messageTooLarge: -32006,
  unsupportedVersion: -32007,
} as const;

export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "BridgeRpcError";
    this.code = code;
    this.data = data;
  }
}

export function toJsonRpcError(error: unknown): JsonRpcErrorShape {
  if (error instanceof BridgeRpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  const message = error instanceof Error ? error.message : "Internal error";
  return { code: BRIDGE_ERROR_CODES.internalError, message };
}

// ---------------------------------------------------------------------------
// hello
// ---------------------------------------------------------------------------

export const HostAppKindSchema = z.enum(["premiere", "ae", "resolve"]);

export const HelloParamsSchema = z.object({
  bridgeVersion: z.number().int().positive(),
  capabilities: z.array(z.string()).max(64),
  hostApps: z.array(HostAppKindSchema).max(8),
});
export type HelloParams = z.infer<typeof HelloParamsSchema>;

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

export const ClientKindSchema = z.enum(["web", "desktop", "premiere", "ae", "resolve"]);

export const PairRequestParamsSchema = z.object({
  clientKind: ClientKindSchema,
  clientName: z.string().trim().min(1).max(120),
  scopes: z.array(z.string()).max(32),
});
export type PairRequestParams = z.infer<typeof PairRequestParamsSchema>;

export const PairRequestResultSchema = z.object({
  pairingId: z.string(),
  /** Present only on the headless fallback path (no tray, or gesture unavailable). */
  code: z.string().length(8).optional(),
  expiresAt: z.string(),
});
export type PairRequestResult = z.infer<typeof PairRequestResultSchema>;

export const PairConfirmParamsSchema = z.object({
  pairingId: z.string(),
  /** Required only for the code-fallback path; a tray-gesture approval omits it. */
  code: z.string().length(8).optional(),
});
export type PairConfirmParams = z.infer<typeof PairConfirmParamsSchema>;

export const PairConfirmResultSchema = z.object({
  pairToken: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
});
export type PairConfirmResult = z.infer<typeof PairConfirmResultSchema>;

export const SessionExchangeParamsSchema = z.object({
  pairToken: z.string(),
});
export type SessionExchangeParams = z.infer<typeof SessionExchangeParamsSchema>;

export const SessionExchangeResultSchema = z.object({
  sessionToken: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
});
export type SessionExchangeResult = z.infer<typeof SessionExchangeResultSchema>;

// ---------------------------------------------------------------------------
// host / engine / fs / media
// ---------------------------------------------------------------------------

export const HostListResultSchema = z.object({
  hosts: z.array(
    z.object({
      kind: HostAppKindSchema,
      version: z.string().optional(),
      running: z.boolean(),
    }),
  ),
});
export type HostListResult = z.infer<typeof HostListResultSchema>;

export const EngineStatusResultSchema = z.object({
  status: z.enum(["idle", "starting", "running", "error", "stopped"]),
  version: z.string().optional(),
  message: z.string().optional(),
});
export type EngineStatusResult = z.infer<typeof EngineStatusResultSchema>;

export const FsPickMediaParamsSchema = z.object({
  multiple: z.boolean().optional(),
  accept: z.array(z.string()).max(32).optional(),
});
export type FsPickMediaParams = z.infer<typeof FsPickMediaParamsSchema>;

/** A handle, never a filesystem path: the client resolves bytes via `media.stat`. */
export const FsPickMediaResultSchema = z.object({
  handles: z.array(z.string()).max(64),
});
export type FsPickMediaResult = z.infer<typeof FsPickMediaResultSchema>;

export const MediaStatParamsSchema = z.object({ handle: z.string().min(1) });
export type MediaStatParams = z.infer<typeof MediaStatParamsSchema>;

export const MediaStatResultSchema = z.object({
  handle: z.string(),
  name: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
});
export type MediaStatResult = z.infer<typeof MediaStatResultSchema>;

export const MediaUploadTicketParamsSchema = z.object({ handle: z.string().min(1) });
export type MediaUploadTicketParams = z.infer<typeof MediaUploadTicketParamsSchema>;

export const MediaUploadTicketResultSchema = z.object({
  uploadUrl: z.string(),
  expiresAt: z.string(),
});
export type MediaUploadTicketResult = z.infer<typeof MediaUploadTicketResultSchema>;

export const TranscriptPushParamsSchema = z.object({
  projectId: z.string(),
  transcriptId: z.string(),
  revision: z.number().int().nonnegative(),
});
export type TranscriptPushParams = z.infer<typeof TranscriptPushParamsSchema>;

// ---------------------------------------------------------------------------
// apply transaction (consumed by C06/C08)
// ---------------------------------------------------------------------------

export const ApplyBeginParamsSchema = z.object({
  projectId: z.string(),
  hostApp: HostAppKindSchema,
  itemIds: z.array(z.string()).min(1).max(5000),
});
export type ApplyBeginParams = z.infer<typeof ApplyBeginParamsSchema>;

export const ApplyBeginResultSchema = z.object({ transactionId: z.string() });
export type ApplyBeginResult = z.infer<typeof ApplyBeginResultSchema>;

export const ApplyStepParamsSchema = z.object({
  transactionId: z.string(),
  step: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});
export type ApplyStepParams = z.infer<typeof ApplyStepParamsSchema>;

export const ApplyStepResultSchema = z.object({ accepted: z.boolean() });
export type ApplyStepResult = z.infer<typeof ApplyStepResultSchema>;

export const ApplyCommitParamsSchema = z.object({ transactionId: z.string() });
export type ApplyCommitParams = z.infer<typeof ApplyCommitParamsSchema>;

export const ApplyCommitResultSchema = z.object({
  committed: z.boolean(),
  appliedSteps: z.number().int().nonnegative(),
});
export type ApplyCommitResult = z.infer<typeof ApplyCommitResultSchema>;

export const ApplyAbortParamsSchema = z.object({
  transactionId: z.string(),
  reason: z.string().optional(),
});
export type ApplyAbortParams = z.infer<typeof ApplyAbortParamsSchema>;

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export const BridgeEventKindSchema = z.enum([
  "engine.status",
  "host.changed",
  "apply.progress",
  "pairing.revoked",
]);
export type BridgeEventKind = z.infer<typeof BridgeEventKindSchema>;

export const EventsSubscribeParamsSchema = z.object({
  events: z.array(BridgeEventKindSchema).min(1).max(16),
});
export type EventsSubscribeParams = z.infer<typeof EventsSubscribeParamsSchema>;

/** Server → client notification (`id` omitted per JSON-RPC 2.0). */
export const BridgeNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("event"),
  params: z.object({ kind: BridgeEventKindSchema, data: z.unknown() }),
});
export type BridgeNotification = z.infer<typeof BridgeNotificationSchema>;

// ---------------------------------------------------------------------------
// method registry — one params/result schema pair per RPC method
// ---------------------------------------------------------------------------

export const BRIDGE_METHODS = {
  hello: {
    params: HelloParamsSchema,
    result: z.object({ bridgeVersion: z.number(), sessionId: z.string() }),
  },
  "pair.request": { params: PairRequestParamsSchema, result: PairRequestResultSchema },
  "pair.confirm": { params: PairConfirmParamsSchema, result: PairConfirmResultSchema },
  "session.exchange": { params: SessionExchangeParamsSchema, result: SessionExchangeResultSchema },
  "host.list": { params: z.object({}).optional(), result: HostListResultSchema },
  "engine.status": { params: z.object({}).optional(), result: EngineStatusResultSchema },
  "fs.pickMedia": { params: FsPickMediaParamsSchema, result: FsPickMediaResultSchema },
  "media.stat": { params: MediaStatParamsSchema, result: MediaStatResultSchema },
  "media.uploadTicket": {
    params: MediaUploadTicketParamsSchema,
    result: MediaUploadTicketResultSchema,
  },
  "transcript.push": {
    params: TranscriptPushParamsSchema,
    result: z.object({ accepted: z.boolean() }),
  },
  "apply.begin": { params: ApplyBeginParamsSchema, result: ApplyBeginResultSchema },
  "apply.step": { params: ApplyStepParamsSchema, result: ApplyStepResultSchema },
  "apply.commit": { params: ApplyCommitParamsSchema, result: ApplyCommitResultSchema },
  "apply.abort": { params: ApplyAbortParamsSchema, result: z.object({ aborted: z.boolean() }) },
  "events.subscribe": {
    params: EventsSubscribeParamsSchema,
    result: z.object({ subscribed: z.array(BridgeEventKindSchema) }),
  },
} as const;

export type BridgeMethod = keyof typeof BRIDGE_METHODS;

export function isBridgeMethod(method: string): method is BridgeMethod {
  return Object.hasOwn(BRIDGE_METHODS, method);
}

/** Methods usable before pairing/session auth is established. */
export const UNAUTHENTICATED_METHODS: ReadonlySet<BridgeMethod> = new Set([
  "hello",
  "pair.request",
  "pair.confirm",
]);
