# `/bridge/relay`

The api-side counterpart of `@montaj/bridge-core`'s `RelayClient` (C01 brief
§3, §6). One WebSocket path, two kinds of connection told apart by their
access token's `kind` claim:

- **bridge** (`kind: "bridge"`) — the local bridge process's outbound tunnel.
- **client** (`kind: "web" | "desktop" | "premiere" | "ae" | "resolve"`) — a
  browser or plugin that cannot reach loopback.

A client's first frame must be `{"t":"attach","deviceId":"..."}`; every frame
after that (and every frame from the bridge once paired) is opaque JSON-RPC
text forwarded byte-for-byte in both directions — this module never parses or
stores a payload past that one `attach` envelope.

`bridge_sessions` (new in this work package) is an audit table only: one row
per connection, `connectedAt`/`disconnectedAt`/`framesRelayed`, written best
effort (a failed insert costs a missing audit row, never a broken pairing —
see the comment in `bridge-relay.gateway.ts`'s `register()`).

`getStats()` on `BridgeRelayGateway` is the admin-visibility hook the brief
names (B13); nothing in this work package's scope wires it into an admin
route, so it exists but is unused outside tests until B13 (or a later pass)
adds a controller for it.

## Known limitation (see the WP report)

Pairing is keyed by `workspaceId:sub` (the JWT's user id), not by a per-device
identifier: CONTRACTS §5 never gives a bridge connection a distinct device id
in its own token (`sub` is always the user), and B08's device registration
does not mint one either. One signed-in user therefore runs one paired bridge
per workspace at a time. A follow-up work package that mints a genuine
per-device bridge credential can widen `deviceKey()` without changing the
wire protocol.
