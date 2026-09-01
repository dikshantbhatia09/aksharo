import { z } from "zod";

/**
 * The `/realtime` wire protocol: rooms, events and frames (CONTRACTS §7).
 *
 * Deliberately a hand-rolled protocol over plain `ws` rather than socket.io: the
 * server needs exactly three verbs, the browser needs no fallback transport in
 * 2026, and the panels (C05a/b) run a CEF 99 Chromium where a smaller dependency
 * surface is worth more than an ecosystem. Every frame is one JSON text frame with
 * a `t` (type) discriminator.
 *
 * The full narrative — handshake, heartbeat, reconnection, back-pressure — is in
 * `src/realtime/README.md`.
 */

/** WebSocket path. Anything else on the upgrade listener is refused. */
export const REALTIME_PATH = "/realtime";

/** Subprotocol the client must offer, so a stray WebSocket client is rejected early. */
export const REALTIME_SUBPROTOCOL = "aksharo.v1";

/** Prefix of the second offered subprotocol that carries the access token. */
export const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

/** Server → client ping interval. Two missed pongs terminate the socket. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MISSES_BEFORE_CLOSE = 2;

/** Rooms a single connection may hold, so one socket cannot subscribe to a tenant. */
export const MAX_ROOMS_PER_CONNECTION = 64;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export type RoomKind = "project" | "workspace";

/** `project:{projectId}` / `workspace:{workspaceId}` (CONTRACTS §7). */
export type Room = `${RoomKind}:${string}`;

export function projectRoom(projectId: string): Room {
  return `project:${projectId}`;
}

export function workspaceRoom(workspaceId: string): Room {
  return `workspace:${workspaceId}`;
}

export interface ParsedRoom {
  readonly kind: RoomKind;
  readonly id: string;
}

/** ULIDs are 26 characters of Crockford base32 (CONTRACTS §0). */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Split a room name, or `undefined` when it is not one this server serves.
 *
 * The id is checked against the ULID shape here rather than in the membership
 * check, so a malformed room never reaches a database query.
 */
export function parseRoom(room: string): ParsedRoom | undefined {
  const separator = room.indexOf(":");
  if (separator < 0) return undefined;
  const kind = room.slice(0, separator);
  const id = room.slice(separator + 1);
  if (kind !== "project" && kind !== "workspace") return undefined;
  if (!ULID_PATTERN.test(id)) return undefined;
  return { kind, id };
}

// ---------------------------------------------------------------------------
// Events (CONTRACTS §7)
// ---------------------------------------------------------------------------

export const REALTIME_EVENTS = [
  "edg.ops",
  "job.progress",
  "job.completed",
  "comment.added",
] as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

/** `job.progress {jobId, progress, etaMs}`. */
export interface JobProgressEvent {
  readonly jobId: string;
  readonly progress: number;
  readonly etaMs?: number;
  /** Not in the contract's minimum shape; additive and safe for clients to ignore. */
  readonly message?: string;
}

/** `job.completed {jobId, status}`. */
export interface JobCompletedEvent {
  readonly jobId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly type?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * `edg.ops {revision, ops, source}` — defined here, emitted by A12.
 *
 * `ops` stays `unknown[]`: the `EdgOp` union lives in `@montaj/edg` (A02) and the
 * realtime layer must not become a second place where it is spelled out.
 */
export interface EdgOpsEvent {
  readonly revision: number;
  readonly ops: readonly unknown[];
  /** Which client produced them, so an editor can ignore its own echo. */
  readonly source: string;
}

/** `comment.added` — defined here, emitted by B15. */
export interface CommentAddedEvent {
  readonly commentId: string;
  readonly projectId: string;
  readonly authorId: string;
  readonly at: string;
}

export interface RealtimeEventPayloads {
  "job.progress": JobProgressEvent;
  "job.completed": JobCompletedEvent;
  "edg.ops": EdgOpsEvent;
  "comment.added": CommentAddedEvent;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const ClientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("subscribe"), rooms: z.array(z.string().max(64)).min(1).max(32) }),
  z.object({ t: z.literal("unsubscribe"), rooms: z.array(z.string().max(64)).min(1).max(32) }),
  z.object({ t: z.literal("ping") }),
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export interface WelcomeFrame {
  readonly t: "welcome";
  readonly connectionId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly heartbeatMs: number;
  readonly protocol: typeof REALTIME_SUBPROTOCOL;
}

export interface SubscribedFrame {
  readonly t: "subscribed";
  /** Rooms this connection now holds after the request. */
  readonly rooms: readonly string[];
  /** Rooms that were refused, with the reason. */
  readonly refused?: readonly { readonly room: string; readonly reason: string }[];
}

export interface EventFrame {
  readonly t: "event";
  readonly room: string;
  readonly event: RealtimeEvent;
  readonly data: unknown;
  /** ISO-8601 timestamp of the publish, for out-of-order detection. */
  readonly at: string;
}

export interface ErrorFrame {
  readonly t: "error";
  readonly code: string;
  readonly message: string;
}

export interface PongFrame {
  readonly t: "pong";
}

export type ServerFrame = WelcomeFrame | SubscribedFrame | EventFrame | ErrorFrame | PongFrame;

/** Close codes this server uses. 4000–4999 is the application-private range. */
export const CLOSE_CODES = {
  unauthenticated: 4401,
  forbidden: 4403,
  protocolError: 4400,
  heartbeatTimeout: 4408,
  serverShutdown: 4503,
} as const;

/** The Redis pub/sub channel a room fans out on. */
export function roomChannel(prefix: string, room: string): string {
  return `${prefix}:realtime:${room}`;
}

/** Inverse of {@link roomChannel}; `undefined` when the channel is not ours. */
export function roomFromChannel(prefix: string, channel: string): string | undefined {
  const head = `${prefix}:realtime:`;
  return channel.startsWith(head) ? channel.slice(head.length) : undefined;
}

/** What travels over Redis between API instances. */
export interface RoomMessage {
  readonly event: RealtimeEvent;
  readonly data: unknown;
  readonly at: string;
}
