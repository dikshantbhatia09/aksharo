# @montaj/engine-client

Typed HTTP/WS client for the local engine sidecar (`apps/engine`, brief
C03a), shared verbatim by `apps/desktop` and `apps/web` so neither hand-rolls
a second parser for the same wire shapes.

```ts
import { EngineClient } from "@montaj/engine-client";

const client = new EngineClient({ baseUrl: `http://127.0.0.1:${port}`, bearer });

const health = await client.health(); // no bearer required on the wire, but harmless to send
const models = await client.models();
const transcript = await client.transcribe({ audio: "file:///path/to/16k.wav", language: "hi" });

for await (const message of client.transcribeStream({ audio: "file:///path/to/16k.wav" })) {
  if (message.kind === "partial") {
    /* update the editor incrementally */
  }
  if (message.kind === "done") {
    /* final TranscribeResponse */
  }
}
```

Every method validates the response with the matching Zod schema
(`src/schemas.ts`) before returning it, so a malformed or version-mismatched
response from the sidecar fails loudly here rather than propagating a bad
shape into the editor. A non-2xx response throws `EngineClientError`
(`.code`, `.status`).

## Wire shapes

`TranscribeRequest`/`TranscribeResponse` and `AlignRequest`/`AlignResponse`
mirror `apps/model-server`'s `/transcribe` and `/align` word shape — the same
`{ start, end, word, probability }` — so a caller's parser does not fork
between the cloud and local paths. Local-only additions (`backend`, engine
version strings) are additive fields, never a divergence in the shared ones.

`EngineDiscoveryFileSchema` is the shape `apps/engine` writes to
`~/.aksharo/engine.json` (`{ port, bearer, pid, version, startedAt }`) — this
package validates it on read; `apps/engine` owns writing it
(`apps/engine/src/discovery.ts`).
