# module: r2-derived

Cloudflare R2 bucket for every client-facing derived object: proxies, 16 kHz and
48 kHz audio, waveforms, thumbnails, exports, fonts and model downloads.

Decision **D35**: egress, not compute, dominates the render bill, and R2 charges
none. Raw uploads stay on S3 `ap-south-1` for residency (module `s3-raw`); this
bucket carries everything a browser or a plugin actually downloads.

## Retention is NOT enforced here — ruling, 2026-09-02

**Fable's ruling: `CONTRACTS §6` keys stay exactly as frozen, and plan-based
retention is enforced by the scheduler (B16), not by storage lifecycle.**

The reasoning, recorded so nobody re-opens it by accident:

R2 lifecycle rules match a **literal key prefix**. No tags, no wildcards, no
suffix matching — a hard constraint of the Cloudflare API, not a choice. The sold
retention ladder (`04` Plans, `05 §9`) is per workspace plan:

| Plan            | Project retention |
| --------------- | ----------------- |
| Free            | 7 days            |
| Starter         | 30 days           |
| Creator         | 90 days           |
| Studio / Agency | 365 days          |

The keys in `CONTRACTS §6` start with the workspace id:

```
ws/{workspaceId}/p/{projectId}/media/{mediaId}/proxy540.mp4
ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}
ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}
```

A prefix rule cannot express "every workspace on the Creator plan", because the
plan does not appear in the key and `ws/*/…` is not a prefix. An earlier draft of
this module put the retention class in front of the key (`r90/ws/…`); that would
have amended a frozen contract, and the ruling is that the contract wins.

**What this costs, stated plainly.** Retention becomes something a scheduled job
promises rather than something the storage layer guarantees. If the sweep stops
running, objects live past their sold retention and past what the privacy notice
says — silently, because nothing else deletes them. Two consequences follow:

- The `MontajQueueStalled` and scheduler alerts in `infra/observability/alerts/`
  are load-bearing for a privacy commitment, not only for throughput.
- `montaj_storage_bytes{retention_class}` in `METRICS.md` is the panel that makes
  a stalled sweep visible: a class that only grows means nothing is expiring.

**Note also that `exports/` and `fonts/` are not top-level prefixes.** Exports live
at `ws/{ws}/p/{p}/exports/…` and fonts at `ws/{ws}/fonts/…`, so the flat
`exports/`, `fonts/`, `models/` and `public/` rules an earlier draft carried
matched no object at all. They are gone. A lifecycle rule on a prefix nothing
uses is worse than no rule: it reads as enforcement in a plan review and deletes
nothing.

`retention_prefixes` is kept as a variable, defaulted to `{}`, with a validation
that every key must start with `ws/`. If a later ADR does move the retention
class into the key, turning lifecycle enforcement back on is one map.

## What the module does create

One lifecycle rule, on the single real `CONTRACTS §6` root:

| Rule id              | Prefix | Action                                         |
| -------------------- | ------ | ---------------------------------------------- |
| `abort-multipart-ws` | `ws/`  | Abort incomplete multipart uploads after 1 day |

That rule earns its place regardless of the retention question. An upload the
browser never finished leaves parts that are billed and do not appear in a bucket
listing, so nobody ever notices them. R2 expresses lifecycle ages in **seconds**,
so the module multiplies days by 86 400.

Plus: the bucket itself (APAC location hint), CORS for browser playback and
range requests, and optionally a custom domain over the Cloudflare CDN.

## Inputs worth reading before you use it

| Variable                   | Why it matters                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location_hint`            | `APAC`. The residency statement in `05 §9` says derived objects sit on R2 with an APAC location hint. Changing this changes what the privacy notice claims. |
| `web_origins`              | Exact origins, never `*`. A wildcard lets any page on the internet read a proxy with a leaked URL.                                                          |
| `retention_prefixes`       | Empty by ruling. See above.                                                                                                                                 |
| `multipart_abort_prefixes` | `["ws/"]` — every derived key, every export, every font.                                                                                                    |

## Access

R2 has no IAM and no IRSA equivalent, so `R2_ACCESS_KEY` and `R2_SECRET_KEY`
(CONTRACTS §1) are genuinely static credentials. They are created by hand in the
Cloudflare dashboard, scoped to this bucket, and stored as `[H]` SSM parameters.
Rotate them on a clock — `docs/runbooks/rotate-secrets.md §E`.

## What this module does not do

- **Versioning.** R2 has no equivalent of S3 object versioning. Everything here
  is regenerable from raw media, so the recovery story is "re-run the media
  jobs", not "restore a version" (`docs/runbooks/restore-from-pitr.md §3`).
- **Public access.** The bucket is private. Clients get objects through the
  custom domain over the Cloudflare CDN, or through short-lived signed URLs
  (THREAT-MODEL T5).
- **Retention.** B16 owns it. See above.
