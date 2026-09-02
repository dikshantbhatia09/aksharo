# `media` — upload, derived objects, import and retention (A06)

Getting a file from a browser into `ap-south-1` without it ever passing through
this process, telling the pipeline about it, handing back short-lived URLs for
what the pipeline produced, and deleting all of it on time.

Design references: `docs/CONTRACTS.md` §3, §4, §6 and §8; `docs/THREAT-MODEL.md`
T5, T6, T7, T24; `03-architecture/07-api-and-contracts.md` §Projects & media;
`06-data-model.md` (media_assets); `04-pricing-and-monetization.md` §Plans;
`12-redesign-decisions.md` D47.

## Endpoints

| Method | Path                                      | Who    | Notes                                                         |
| ------ | ----------------------------------------- | ------ | ------------------------------------------------------------- |
| `GET`  | `/projects/{id}/media`                    | viewer | Includes imported subtitle sidecars (role `subtitle`).        |
| `POST` | `/projects/{id}/media/init`               | editor | Plan check, then presigned multipart parts.                   |
| `POST` | `/media/{mediaId}/complete`               | editor | Closes the upload; enqueues `media.probe` then `media.proxy`. |
| `POST` | `/projects/{id}/media/{mediaId}/complete` | editor | The same call under 07's path.                                |
| `POST` | `/projects/{id}/media/{mediaId}/replace`  | editor | New bytes on the same row; sets `needsRealign`.               |
| `GET`  | `/projects/{id}/media/{mediaId}/urls`     | viewer | Five-minute signed GETs for whatever exists.                  |
| `GET`  | `/media/{mediaId}`                        | viewer | One asset.                                                    |
| `POST` | `/projects/{id}/import`                   | editor | SRT/VTT/ASS/TXT → cue list → `ai.align`.                      |
| `POST` | `/projects/{id}/import-url`               | editor | The same, fetched through the SSRF-safe client.               |

The worker's write-back path is A08's `PATCH /internal/media/{id}`, behind the
signed internal surface, and stays there.

## The upload, end to end

```
POST /projects/{id}/media/init  { filename, size, mime, contentHash? }
  -> { mediaId, uploadId, key, partSizeBytes, parts: [{ partNumber, url }], expiresAt }

PUT  <each part url>  (the browser, straight to the bucket)  -> ETag

POST /media/{mediaId}/complete  { etags: ["\"a\"", "\"b\""] }   // in part order
  -> { media, probeJobId, proxyJobId }
```

**The bytes never touch this process.** An API that proxied uploads would hold a
Node process for the length of a 2 GB transfer and would put the residency
boundary (T24) in the wrong place. Parts are 16 MiB, which is comfortably above
the 5 MiB minimum and keeps the part count — and therefore the number of
signatures in one `init` response — small.

The order inside `complete` is the design:

```
complete the multipart upload -> HEAD for the real size -> row (uploadedAt,
  purge dates) -> enqueue media.probe -> enqueue media.proxy
```

The object is finished before the row says so, and the row is written before
anything is enqueued, so a worker can never pick up a job for an object that is
not there. `JobsService.enqueue` dedupes on `jobKey` (`media.probe:{mediaId}`),
so a client that retries `complete` after a dropped response gets **the same two
job ids** rather than four jobs.

`size` is the client's claim and is only ever used to decide how many parts to
sign and to fail early against the plan cap. `complete` HEADs the finished object
and writes the store's own number; if that turns out to be over the cap the
object is deleted and the row failed, because the alternative is storing
something nothing may read.

### Duplicate detection

`contentHash` is matched across the **whole workspace**, not the project: the same
footage cut into two projects should upload once. A hit returns the existing media
with `duplicate: true`, no `uploadId` and no parts, so a client that ignores the
flag simply has nothing to PUT.

### Replace

`replace` puts new bytes on the **same row**, because the project's transcript,
EDG document and exports all reference that media id and a new row would orphan
every one of them. Everything describing the old bytes is cleared (duration,
dimensions, proxy, audio, waveform, thumbnails) and `needs_realign` is set: the
words survive a re-shoot of the same take, the timings do not, and A11 reads that
flag to decide whether to re-run `ai.align`. Any upload the client abandoned is
aborted first, so it stops holding parts in the bucket.

## Storage (`src/common/storage`)

Two `ObjectStore` instances, injected by token, because they are two systems:

| Token           | Bucket              | Holds                                            | Production               |
| --------------- | ------------------- | ------------------------------------------------ | ------------------------ |
| `RAW_STORE`     | `S3_BUCKET_RAW`     | the original upload                              | AWS S3, ap-south-1 (T24) |
| `DERIVED_STORE` | `R2_BUCKET_DERIVED` | proxy, 16k/48k audio, waveform, thumbs, sidecars | Cloudflare R2            |

Making the caller name the store means a proxy can never be written into the
residency bucket by a typo, and it is why `media_assets.bucket` exists. In
development both are MinIO.

`storage.keys.ts` is the TypeScript twin of
`apps/worker-ai/worker_ai/storage.py`; the two are only ever correct together, so
both refuse to build a key from anything that is not a ULID. Every id in a key
arrives from a request or a job payload, and a key is a path — `../` in an id
would be a cross-tenant write (T5).

| What              | Key                                                              | Store |
| ----------------- | ---------------------------------------------------------------- | ----- |
| Raw upload        | `ws/{ws}/p/{project}/media/{media}/raw.{ext}`                    | S3    |
| Proxy             | `ws/{ws}/p/{project}/media/{media}/proxy540.mp4`                 | R2    |
| Audio             | `ws/{ws}/p/{project}/media/{media}/audio16k.wav`, `audio48k.wav` | R2    |
| Waveform          | `ws/{ws}/p/{project}/media/{media}/waveform.json`                | R2    |
| Thumbnails        | `ws/{ws}/p/{project}/media/{media}/thumb-{n}.jpg`                | R2    |
| Imported subtitle | `ws/{ws}/p/{project}/media/{media}/subtitle.json`                | R2    |

The subtitle sidecar is the one key CONTRACTS §6 does not enumerate, because an
imported subtitle is not _derived_ from the media — it arrives with it. It is
filed under the same media prefix so one lifecycle rule and one purge sweep cover
the lot, and named outside the enumerated set so no reader can mistake it for
something a worker wrote.

Two client settings in `s3-object-store.ts` are load-bearing rather than
cosmetic: `forcePathStyle` (R2 and MinIO address a bucket as `/{bucket}/{key}`)
and `requestChecksumCalculation: "WHEN_REQUIRED"` — since AWS SDK v3.729 the SDK
adds a CRC32 header to uploads by default, and a presigned URL cannot carry one,
because the client that PUTs the bytes is a browser that never sees the SDK. The
signature would cover a header the browser does not send and every part upload
would fail with `SignatureDoesNotMatch`.

## Media types (THREAT-MODEL T7)

An allow-list, not a deny-list: the alternative is enumerating everything ffmpeg
can be persuaded to open. `application/octet-stream` is accepted only when the
filename's extension is one we know, because that is what a browser sends when it
cannot guess. The declared type is only ever a claim — A07's probe reads the
actual container and rewrites `mime` — and this check exists to reject the obvious
before a gigabyte moves.

The extension that reaches a key is chosen from the same allow-lists, so no
attacker-controlled string is ever interpolated into a path.

## Retention (D47)

Two independent clocks, and keeping them apart is the point:

| Column             | When                       | What goes                                |
| ------------------ | -------------------------- | ---------------------------------------- |
| `raw_purge_at`     | upload + **7 days**, fixed | the original file                        |
| `derived_purge_at` | upload + plan retention    | proxy, audio, waveform, thumbs, sidecars |

A project stays perfectly usable after its raw media has gone — the editor reads
the proxy and the 16 kHz audio — and what is lost is the ability to re-derive at a
different quality. That is why raw is the shorter of the two on every plan, and it
is the most expensive thing we store.

`RetentionService.purgeDueMedia()` is a **method a scheduler can call**, and
registers no schedule of its own: B16 owns that wiring, and a sweep that started
itself in every process — including a developer's laptop pointed at a shared
bucket — is how a demo database loses its media. The object is deleted first and
`*_purged_at` written only after the store confirms, so a crash in between leaves
a row that is swept again and a delete that is idempotent. The other order would
silently strand paid-for storage.

## Subtitle import

An existing subtitle file is a transcript somebody already paid for: the words are
right and only the timings need work. So the import path parses SRT, WebVTT, ASS
or plain text into one normalised cue list, stores it as a JSON sidecar, and
enqueues `ai.align`. It does **not** create a transcript — that is A11's, and
inventing half of one here would be a second implementation for A11 to delete.

Three parser details are load-bearing rather than defensive:

- **the byte-order mark is stripped** — Windows tools write UTF-8 with a BOM more
  often than not, and a BOM in front of `WEBVTT` or of `1` makes the first cue of
  an otherwise perfect file vanish;
- **line endings are normalised first** — a CRLF file split on a blank line never
  finds one, because every "blank" line still holds a `\r`;
- **nothing is transliterated or case-folded** — Devanagari, Tamil and mixed
  Roman/native text pass through byte for byte. The only text the parsers touch is
  ASS override syntax (`{\an8}`, `\N`, `\h`), which is markup rather than content.

Plain text carries no timings at all, so its cues are at time zero and `timed` is
false: that is the signal alignment needs — text to align against the audio, not
timings to trust.

The sidecar is a `media_assets` row with role `subtitle`, which means the
retention sweep, the purge dates and the project cascade all cover it with no
special case anywhere.

## Outbound fetches (`src/common/net`, THREAT-MODEL T6)

`POST /projects/{id}/import-url` and, later, B14's webhooks go through
`safeFetch`. Per hop:

1. **scheme and port** — `http`/`https` on port 80 or 443. `file:`, `gopher:` and
   `redis:` never reach a resolver.
2. **resolve first, judge every address** — each answer is checked against
   `ip-rules.ts`; if _any_ is private, loopback, link-local, the metadata service,
   a ULA or otherwise reserved, the whole request is refused. Checking only the
   address we would use would let a second record through on the next lookup.
3. **pin the address** — the connection goes to the vetted IP with the original
   `Host` header and SNI, so the name cannot be re-resolved between the check and
   the connect. That gap is the whole of DNS rebinding.
4. **cap redirects, size and time** — three redirects, 2 MB, ten seconds. A
   redirect is a fresh URL and gets the full treatment again, which is how "public
   host redirects to `169.254.169.254`" is caught.

A refusal reaches the client as `import/blocked_url` with **no detail**: telling
the caller "10.0.0.5 is RFC1918 private" would turn the import endpoint into a
port scanner with a helpful oracle attached.

## Credits

`media.probe` and `media.proxy` hold **zero** tenths.
`04-pricing-and-monetization.md` bills transcription, translation, audio clean,
passes and cloud renders; probing an upload and making a 540p proxy are the cost
of storing the file at all and are priced into the plan. The call still goes
through `CreditsFacade.reserve`, because CONTRACTS §4 says every producer must, so
admission control, the audit trail and B02's ledger all see the job — the amount
is simply nothing.
