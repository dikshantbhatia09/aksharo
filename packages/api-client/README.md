# @montaj/api-client

The typed API surface every Aksharo client uses: fetch layer, endpoint
descriptors, TanStack Query hooks and the realtime client.

**Status:** implemented. A03 froze the spec, A04 built the generator, A13 built
everything on top of it.

## Three layers

```
src/generated/operations.ts  every operation id, method and path (generated)
openapi.json                 the whole OpenAPI document (generated)
src/endpoints.ts             typed descriptors: method, path, auth, req/res
src/http.ts                  the fetch layer
src/hooks.ts                 TanStack Query over the descriptors
src/realtime.ts              the WebSocket client (CONTRACTS §7)
```

`pnpm gen:client` rewrites the two generated files from the API's own Swagger
output. Nothing under `src/generated/` is hand-edited.

### Endpoint descriptors

The generator emits ids, methods and paths — enough to prove a route exists, not
enough to type its body. So the bodies live in `types.ts` next to the descriptor,
and `contract.test.ts` checks every descriptor against the generated index. Two
ways to fail, both the ones that matter:

- a descriptor whose `operationId` is missing, or whose method or path moved;
- a descriptor marked `pending` whose route has since landed.

`pendingEndpoints` are the routes `07-api-and-contracts.md` specifies but whose
work package has not merged (today: all of A05 — `/me`, `/workspaces`,
`/entitlement`, `/usage`, `/consents`, `/memory`, `/me/data`). Calling one raises
`client/not_implemented` without a request, and the hooks resolve it to a
fallback so the shell renders honestly instead of showing an error state for
weeks. When A05 lands, `contract.test.ts` fails and the descriptor moves.

### The fetch layer

`ApiClient` owns the base URL, the bearer header, the CONTRACTS §8 error envelope
and one silent refresh:

- a 401 on a **bearer** route triggers at most one rotation, shared by every
  request that hit a 401 at the same time, then the request is replayed once;
- a 401 on a **public** route is a domain answer (`auth/invalid_credentials`) and
  never rotates — refreshing there would sign a user out of a session they were
  in the middle of creating;
- every failure arrives as `ApiError` with `code`, `status`, `details`,
  `requestId` and `retryAfterMs`, including transport failures
  (`network/unreachable`), so a caller has one error type.

It owns **no storage**. Where the refresh token lives is a property of the
surface: an httpOnly cookie in the browser, the OS keychain on the desktop,
nothing at all in a panel. The client asks for an access token through
`getAccessToken` and for a new one through `refreshAccessToken`.

`SessionStore` keeps the 15-minute access token **in memory only** and decodes
its claims for display — never for an authorisation decision; the signature is
the API's business.

### Hooks

```ts
const { data } = useEntitlement(); // keyed by workspace
const switchWorkspace = useSwitchWorkspace(persistSession);
```

Rules that apply to all of them: a workspace-scoped query is keyed by the
workspace id so a switch cannot show the previous tenant's numbers (T4);
`useSwitchWorkspace` clears the whole cache on success; nothing retries a 4xx.

### Realtime

`RealtimeClient` speaks the protocol in `apps/api/src/realtime/README.md`:
subprotocol `aksharo.v1` plus `bearer.<token>` (never a query string — T21),
exponential backoff with jitter capped at 30 s, re-subscribe after every
`welcome`, `onResync` so the caller re-reads rather than replaying, refused rooms
remembered, and close codes handled (4401 refreshes first, 4403 drops the room).

```ts
const client = new RealtimeClient({ url, getAccessToken, onResync });
client.subscribe(rooms.workspace(workspaceId));
client.connect();
```

> **Known blocker (found by A13, owned by A08).** The API's `RedisRealtimeBus`
> duplicates a connection created with `lazyConnect: true` and
> `enableOfflineQueue: false`, so the duplicate is never dialled and the first
> `SUBSCRIBE` rejects with "Stream isn't writeable" — which takes the API process
> down. The shell therefore keeps its WebSocket behind
> `FEATURE_FLAGS_JSON={"realtime.enabled":true}` until that is fixed. The client
> here is complete and tested.

## Module format

ESM only (`"type": "module"`). A CommonJS build would resolve
`@tanstack/react-query` through the `require` condition while the app resolves it
through `import`, producing two `QueryClientContext` objects and a
"No QueryClient set" error that points nowhere near the cause.

## Scripts

| Script                                       | What it does                                    |
| -------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/api-client build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/api-client typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/api-client lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/api-client test`      | Vitest (jsdom)                                  |

Coverage gate 75/70, the service tier of CONTRACTS §9.
