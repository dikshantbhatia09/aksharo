# @montaj/render-manifest

The server-signed render manifest: schema, signature, expiry and caps.

**Status:** implemented (A20). Consumed by `apps/render` today, by A21 (which issues and
signs manifests) and by A19's browser exporter.

`03-architecture/05-system-architecture.md` §5.2 makes the manifest the first step of
every export: `POST /projects/{id}/exports` returns one, and nothing draws a frame
without it.

## Why it is signed

Two fields decide money, and neither may come from a job payload:

- **`watermark`** — `{assetId, position, opacity}` or `null`. An unentitled workspace
  never receives a manifest with `null` there, and a worker cannot be talked into one
  (THREAT-MODEL T10).
- **`caps`** — the workspace's real entitlement. `assertWithinCaps` refuses an `output`
  that exceeds it, so the plan ladder is enforced where the pixels are made and not
  only where the request was accepted.

Everything else in the document is a **snapshot** rather than a pointer: the EDG
revision, the style-catalogue content ids, the timemap edits and the source key are all
pinned, so a job that sits in a queue while the project moves on still renders the video
that was asked for.

## Using it

```ts
import { assertWithinCaps, verifyRenderManifest } from "@montaj/render-manifest";

const { manifest, key } = verifyRenderManifest({
  manifest: envelope.payload.manifest,
  secret: env.INTERNAL_CALLBACK_SECRET,
  secretNext: env.INTERNAL_CALLBACK_SECRET_NEXT,
});
assertWithinCaps(manifest, timemap.outputDurationMs);
```

Four refusals, each with its own code, because "the render failed" and "your plan does
not include 4K" are different conversations: `manifest/malformed`,
`manifest/bad-signature`, `manifest/expired`, `manifest/not-yet-valid`,
`manifest/caps-exceeded`.

`assertWithinCaps` takes the **rendered** length, not the source length: a two-hour
recording cut down to forty seconds is a forty-second render and is measured as one.

## The signature

```
signature = hex(hmac_sha256(secret, "montaj.render-manifest.v1." + canonicalJson(manifest_without_signature)))
```

Three decisions, each closing a hole:

1. **Canonical JSON, not the wire bytes.** CONTRACTS §3 signs callbacks over the exact
   bytes because both ends hold them. A manifest does not survive that way — it goes
   through a database column, a job payload and a `JSON.parse`/`JSON.stringify` round
   trip — so the signature is over a canonical form: keys sorted, `undefined` dropped,
   no whitespace. Zod applies its defaults before the check, so an issuer that omitted
   an optional field and a verifier that received it explicitly agree.
2. **A domain-separation prefix.** The key is `INTERNAL_CALLBACK_SECRET`, which also
   signs worker → API callbacks; the prefix means neither signature can be replayed as
   the other. The prefix carries `v1`, so a v2 manifest can never verify under a v1
   signature even if every field happens to match.
3. **Two-key verification.** `INTERNAL_CALLBACK_SECRET_NEXT` is accepted as a second
   verification key, exactly as the API accepts it for callbacks, so one rotation
   procedure covers both directions. The issuer always signs with the primary.

No new environment variable: CONTRACTS §1 already carries both keys.

## Presets

`PRESET_DIMENSIONS` is the `05 §5.2` table — Reels and Shorts 1080×1920, YouTube 4K
3840×2160, Square 1080×1080, plus `custom` which carries its own size. It lives here
rather than in `apps/render` because A21 uses it to _write_ `output.width`/`height` and
the renderer only reads them.

`coverScaleCrop` is the centre "cover" fit the renderer turns into an ffmpeg
`scale`+`crop` pair: scale until the source covers the target on both axes, then crop
the overflow symmetrically. Cover rather than contain, because a Reel with letterbox
bars is a bug report and because the caption layout is computed for the full target
canvas.

## Layout

```
src/schema.ts     the Zod document and its field types
src/signature.ts  canonical JSON, signing, constant-time verification
src/verify.ts     parse + verify + clock + caps
src/presets.ts    the preset table and the cover fit
src/errors.ts     RenderManifestError and its codes
src/testing.ts    a valid manifest to build fixtures on
```

## Scripts

| Script                                            | What it does                                    |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-manifest build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/render-manifest typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/render-manifest lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-manifest test`      | Vitest                                          |
