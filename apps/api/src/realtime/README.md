# `/realtime` — WebSocket protocol

The push channel of `docs/CONTRACTS.md` §7. One WebSocket per client, rooms for
scoping, JSON text frames both ways, and Redis pub/sub so it works with more than
one API instance behind a load balancer.

Plain [`ws`](https://github.com/websockets/ws) on the HTTP server Nest already
owns, not socket.io and not `@nestjs/websockets`: the protocol is three client
verbs, and every browser and Chromium panel we target speaks RFC 6455 natively.

## Handshake

```
GET /realtime HTTP/1.1
Upgrade: websocket
Sec-WebSocket-Protocol: aksharo.v1, bearer.<access token>
```

The access token goes in `Sec-WebSocket-Protocol` because that is the only header
a browser can set on a WebSocket handshake, and a token in the query string ends
up in every access log, proxy trace and error report (THREAT-MODEL T21). The
server echoes back **only** `aksharo.v1`.

```ts
const socket = new WebSocket(`${API_ORIGIN.replace(/^http/, "ws")}/realtime`, [
  "aksharo.v1",
  `bearer.${accessToken}`,
]);
```

Non-browser clients — the desktop app, the local bridge, the panels through the
bridge — may send `Authorization: Bearer <token>` instead. Either is accepted;
the `Authorization` header wins when both are present.

Authentication happens **during the upgrade**. A missing, malformed, expired or
wrongly-signed token gets `HTTP/1.1 401 Unauthorized` and no WebSocket is created;
there is no "connect first, authenticate later" window. The workspace comes from
the token's `ws` claim and never from anything the client sends (THREAT-MODEL T4).

On success the first frame is:

```json
{
  "t": "welcome",
  "connectionId": "01JC…",
  "userId": "01JC…",
  "workspaceId": "01JC…",
  "heartbeatMs": 30000,
  "protocol": "aksharo.v1"
}
```

## Client → server frames

| Frame                               | Meaning                                  |
| ----------------------------------- | ---------------------------------------- |
| `{"t":"subscribe","rooms":[...]}`   | Join rooms. Up to 32 per frame, 64 held. |
| `{"t":"unsubscribe","rooms":[...]}` | Leave rooms.                             |
| `{"t":"ping"}`                      | Application-level liveness check.        |

Anything else — malformed JSON, an unknown `t`, a frame over 8 KiB — is answered
with `{"t":"error","code":"realtime/bad_frame"}`. The connection stays open: a
buggy client should not lose its subscriptions over one bad frame.

## Server → client frames

| Frame                                                        | Meaning                  |
| ------------------------------------------------------------ | ------------------------ |
| `{"t":"welcome",...}`                                        | Handshake accepted.      |
| `{"t":"subscribed","rooms":[...],"refused":[{room,reason}]}` | The rooms now held.      |
| `{"t":"event","room","event","data","at"}`                   | A room event.            |
| `{"t":"pong"}`                                               | Reply to `{"t":"ping"}`. |
| `{"t":"error","code","message"}`                             | A frame was rejected.    |

`subscribed` always reports the **complete** set of rooms the connection holds,
not a delta, so a client that missed a reply can resynchronise from any one of
them. `refused` carries `forbidden`, `not_found`, `unknown_room` or
`too_many_rooms`.

## Rooms

| Room                      | Who may join                                                                |
| ------------------------- | --------------------------------------------------------------------------- |
| `workspace:{workspaceId}` | `workspaceId` equals the token's `ws` claim, and the membership is active.  |
| `project:{projectId}`     | The project belongs to the token's workspace, and the membership is active. |

Both checks run on every `subscribe`; the token being valid is not enough,
because it lives for 15 minutes and a membership can be revoked inside that
window. A project in another workspace and a project that does not exist are both
`not_found`, so room names cannot be used to enumerate ids (THREAT-MODEL T5).

## Events

The four of CONTRACTS §7, with the payload carried in `data`:

| Event           | Room                | Payload                                | Emitted by |
| --------------- | ------------------- | -------------------------------------- | ---------- |
| `job.progress`  | workspace + project | `{jobId, progress, etaMs?, message?}`  | A08        |
| `job.completed` | workspace + project | `{jobId, status, type?, error?}`       | A08        |
| `edg.ops`       | project             | `{revision, ops, source}`              | A12        |
| `comment.added` | project             | `{commentId, projectId, authorId, at}` | B15        |

A job event is published to the workspace room **and** the project room when the
job has a project, so a client watching either sees it once.

## Heartbeat

The server sends a WebSocket ping every 30 s. Two consecutive pings without a
pong (60 s) close the connection with code **4408**. Browsers answer pings in the
platform, so a normal web client needs no code for this; a custom client must
answer pings or send `{"t":"ping"}` at least every 30 s.

`{"t":"ping"}` → `{"t":"pong"}` exists for clients that cannot observe protocol
frames (some panel environments) and for measuring round-trip latency.

## Reconnection

Realtime is a **courtesy channel, not a source of truth.** Every event it carries
is also available from a REST read (`GET /jobs/{id}`, `GET /edg/{id}`), so a
client that misses events converges by re-reading rather than by replaying. There
is no message buffer, no sequence number and no resume token.

A client should therefore:

1. Reconnect with exponential backoff and jitter — 1 s, 2 s, 4 s … capped at 30 s
   — and never in a tight loop; a restarting API must not be met with a thundering
   herd.
2. Re-`subscribe` to its rooms after every `welcome`. Subscriptions are per
   connection and are not restored.
3. **Re-read** the state behind each room once it is subscribed again: refetch the
   open jobs, refetch the EDG revision. Anything that happened while the socket
   was down is only in the database.
4. Treat close code 4401 (unauthenticated) as "refresh the access token first",
   4403 as "do not retry this room", and 4503 as a deploy — reconnect normally.

## Close codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 4400 | Protocol error.                                 |
| 4401 | Unauthenticated (also the HTTP 401 on upgrade). |
| 4403 | Forbidden.                                      |
| 4408 | Heartbeat timeout.                              |
| 4503 | Server shutting down.                           |

## Fan-out across instances

A room lives on whichever API instances hold a socket for it. Publishing goes
through `RealtimePublisher` → `RealtimeBus` → Redis `PUBLISH` on
`{MONTAJ_QUEUE_PREFIX}:realtime:{room}`; every instance holding that room is
`SUBSCRIBE`d and delivers to its own sockets.

Two properties fall out of that, both deliberate:

- **Reference-counted subscriptions.** An instance subscribes when its first
  socket joins a room and unsubscribes when its last one leaves, rather than
  pattern-subscribing to everything and filtering locally.
- **One delivery path.** An instance's own publish comes back to it through Redis
  like everybody else's. There is no local shortcut, so there is no second code
  path that only breaks behind a load balancer.

`RealtimeBus` is an interface. `RedisRealtimeBus` is production;
`InMemoryRealtimeBus` over a shared `InMemoryRealtimeBroker` is what lets the
suite run two gateways in one process and assert the fan-out with no
infrastructure at all.

### Connecting (A08c)

`RedisService` builds its client with `lazyConnect: true` — so constructing the
module graph does not dial Redis — and `enableOfflineQueue: false`, which is what
BullMQ wants of a connection it blocks on. `duplicate()` inherits **both**, so a
freshly duplicated subscriber sits in `wait` and its first `SUBSCRIBE` is not
queued until the socket opens: it is rejected outright with
`Stream isn't writeable and enableOfflineQueue options is false`. Nothing retries
it, so the room is simply never delivered to.

`RedisRealtimeBus` therefore brings each connection up explicitly before issuing a
command, on both the subscriber and the shared publishing client. ioredis restores
subscriptions itself across a reconnect, so nothing here replays them.

A room whose subscription cannot be established is **refused** — `subscribed`
comes back with `refused: [{ room, reason: "unavailable" }]` and no local
membership is left behind — rather than joined silently. A client told it is in a
room it will never receive an event for is worse off than one told to try again.

## Testing

```bash
pnpm --filter @montaj/api test realtime
```

| Suite                             | Needs                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `test/realtime.e2e-spec.ts`       | nothing — two gateways over one in-memory broker.              |
| `test/realtime-redis.e2e-spec.ts` | the compose Redis; two gateways with their own `RedisService`. |

Both boot a real HTTP server and drive a real `ws` client.
`MONTAJ_SKIP_REDIS_TESTS=1` skips the Redis one, which exists because the
in-memory bus cannot catch a defect in the _connection_ handling: A08 shipped a
`RedisRealtimeBus` that could not subscribe at all, and every test passed.
