import { z } from "zod";

/**
 * `/bridge/relay` (C01 brief §3, CONTRACTS §7 "Bridge relay rooms `bridge:
 * {workspaceId}` (Wave 4)"): the api-side counterpart of `bridge-core`'s
 * `RelayClient`. Two kinds of socket connect to the same path and are told apart
 * by their access token's `kind` claim:
 *
 *  - **bridge** (`kind: "bridge"`, a device token minted for B08's device
 *    registration) — one per running local bridge, registers under its device id.
 *  - **client** (`kind: "web" | "desktop" | "premiere" | "ae" | "resolve"`) —
 *    sends `attach {deviceId}` naming which bridge in its own workspace to relay
 *    to, then every further text frame is opaque JSON-RPC forwarded byte for byte
 *    in both directions. The relay parses only the `attach` envelope; it never
 *    parses or stores an RPC payload (brief §3: "the relay never stores payloads").
 */

export const BRIDGE_RELAY_PATH = "/bridge/relay";
export const BRIDGE_RELAY_SUBPROTOCOL = "aksharo.v1";
export const BRIDGE_RELAY_BEARER_PREFIX = "bearer.";

/** Same ceiling as `@montaj/bridge-core`'s `MAX_MESSAGE_BYTES` — the two ends of one tunnel must agree. */
export const MAX_RELAY_FRAME_BYTES = 512 * 1024;

export const HEARTBEAT_INTERVAL_MS = 20_000;
export const HEARTBEAT_MISSES_BEFORE_CLOSE = 2;

export const ClientAttachFrameSchema = z.object({
  t: z.literal("attach"),
  deviceId: z.string().min(1).max(32),
});
export type ClientAttachFrame = z.infer<typeof ClientAttachFrameSchema>;

/** Close codes this relay uses. 4000-4999 is the application-private range (mirrors `realtime.protocol.ts`). */
export const RELAY_CLOSE_CODES = {
  unauthenticated: 4401,
  forbidden: 4403,
  protocolError: 4400,
  heartbeatTimeout: 4408,
  peerUnavailable: 4404,
  rateLimited: 4429,
  serverShutdown: 4503,
} as const;
