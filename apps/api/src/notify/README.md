# `notify` — transactional mail and in-app notifications (A25)

Everything the platform says to a person outside the app: the links that get them
back into an account, the notices the law requires, and the bell in the app shell.

```
producer ──► NotifyService.enqueue ──┬──► notifications row ──► realtime notification.created
                                     │
                                     └──► BullMQ `notify` ──► NotifyConsumer
                                                                  │
                                    suppression → per-recipient limit → receipt
                                                                  │
                                              render (ICU, en/hi) ─┴─► MailProvider
                                                                       ses │ smtp │ dev
```

## Sending something

```ts
await this.notify.enqueue({
  kind: "export-ready",
  to: user.email,
  locale: user.locale, // "en-IN", "hi-IN"; anything else falls back to English
  userId: user.id, // required for the kinds that appear in the bell
  workspaceId: workspace.id, // also the realtime room
  data: { project: project.name, link, days: 7 },
  idempotencyKey: `export-ready-${exportId}`,
});
```

The `locale` is the recipient's own: A04's flows read `users.locale` (defaulting
to `en-IN`) and pass it through `AuthMailerService`, so a Hindi user gets a Hindi
subject line. `test/notify-locale.e2e-spec.ts` proves that end to end, through a
real sign-up.

`enqueue` does not throw for a delivery reason. A notification is a side effect of
work the caller cares about, so a Redis hiccup is logged and swallowed, exactly as
`RealtimePublisher` swallows one. It throws only for a caller bug: an unknown kind
or a missing recipient.

`idempotencyKey` becomes the BullMQ job id, and BullMQ refuses a second job with an
id it already holds — so a webhook delivered twice sends one message. Pass one
whenever the same message could legitimately be produced twice; omit it and a
unique key is minted, which deduplicates nothing.

The job's `data` is the CONTRACTS §3 envelope with `{kind, to, locale, data,
idempotencyKey}` as its `payload`. A message produced before a user belongs to any
workspace — the address verification at sign-up — uses the sentinel
`workspaceId: "none"`, because the envelope requires a non-empty one.

## The three transports

| `MAIL_PROVIDER` | Used by                    | Credentials                      | Needs                   |
| --------------- | -------------------------- | -------------------------------- | ----------------------- |
| `ses`           | cloud                      | the pod's IRSA role — **no key** | `MAIL_FROM`             |
| `smtp`          | self-hosted, local Mailpit | in `SMTP_URL`                    | `MAIL_FROM`, `SMTP_URL` |
| `dev`           | a developer, the e2e suite | none                             | nothing                 |

`ses` takes its region from `S3_REGION`, so mail leaves the region the media lives
in (THREAT-MODEL T24). The provider is chosen once at boot and a misconfigured one
is a startup failure, not a queue quietly filling with undeliverable jobs.

`dev` writes to the Redis list A04 introduced (`montaj:auth:dev-outbox`), in A04's
entry shape plus the rendered message. That is what lets `test/auth.e2e-spec.ts`
complete a real sign-up with no mail server, and what
`node tools/runbooks/mail-outbox.js` prints. It refuses to run in production.

Locally with a real client:

```bash
docker compose --profile mail up -d     # Mailpit: SMTP on 1025, UI on http://localhost:8025
# .env: MAIL_PROVIDER=smtp  MAIL_FROM="Aksharo <hello@aksharo.ai>"  SMTP_URL=smtp://localhost:1025
```

## The consumer

One BullMQ `Worker` inside the API process — sending is a render and one HTTPS
call, so a second deployable would be a rollout and an on-call surface for work the
API is already sized for. `NOTIFY_WORKER_ENABLED=0` turns it off for processes that
must not run one (the OpenAPI emitter, test suites with a substituted Redis), the
same way `MONTAJ_SCHEDULER_DISABLED` does for the scheduler. It defaults **on**,
because a deployment that forgot it would silently stop sending mail.

Order inside one job:

1. **Suppression.** A hard bounce or a complaint stops everything, including the
   critical kinds, and writes an audit row saying what was not sent.
2. **Per-recipient limit.** Ten non-critical messages an hour to one mailbox
   (bucket keyed on the address hash). The critical kinds skip it: a rate limit
   must never be the reason somebody cannot get back into their account.
3. **Delivery receipt.** Checked before the render, written after the send, so a
   retry after a successful send is a no-op. `notify` retries five times with a
   two-second exponential backoff (`RETRY_POLICY_BY_PREFIX` in `jobs.config.ts`).
4. **Render**, then **send**. A malformed payload or a template with a missing
   variable is an `UnrecoverableError` — no amount of retrying fixes either, and
   five attempts only delay the moment somebody looks at the dead-letter queue.

## Kinds

Thirteen, in `notify.kinds.ts`, each classified three ways:

| Kind                          | Critical | In the bell | Unsubscribe |
| ----------------------------- | :------: | :---------: | :---------: |
| `verify-email`                |    ●     |             |             |
| `magic-link`                  |    ●     |             |             |
| `password-changed`            |    ●     |             |             |
| `device-approval`             |    ●     |             |             |
| `login-new-device`            |    ●     |      ●      |             |
| `parental-waitlist`           |          |             |             |
| `renewal-notice`              |          |      ●      |             |
| `low-credits`                 |          |      ●      |      ●      |
| `export-ready`                |          |      ●      |             |
| `share-comment`               |          |      ●      |      ●      |
| `streak-nudge` (B06)          |          |      ●      |      ●      |
| `retention-warning` (B16)     |          |      ●      |             |
| `support-ticket-created` (B12)|          |             |             |

**Critical** means never rate limited. **Unsubscribe** means a `List-Unsubscribe`
header (RFC 8058 one-click) and a footer link; everything else is transactional or
legally required — `renewal-notice` is the pre-debit notice the RBI e-mandate rules
demand — and an unsubscribe link on one of those is a promise the product does not
keep.

Adding a kind is a name in `notify.kinds.ts`, a row in each of the three
classification lists, and an English _and_ Hindi entry in `templates/messages.*.ts`.
`notify.kinds.test.ts` fails until all of them exist.

## Templates

Hand-written HTML and text, ICU MessageFormat strings, English and Hindi
(`08-ux-design-system.md` §6). No MJML: the whole set is one column, one button and
a footer, and a compiler would be a build step for markup that fits on a screen.

- **No remote images, so no tracking pixel.** The platform does not learn whether a
  message was opened, and there is nothing to disclose because nothing is collected.
- Values are HTML-escaped **before** ICU formats them, so a project called `<b>`
  becomes text rather than markup. The text part is formatted separately from the
  same strings, so it is a real alternative and not a tag-stripped copy.
- Brand words never appear in a string: they arrive as `{brand}` and `{support}`
  from `packages/config/src/brand.ts` (CONTRACTS §0).
- A missing variable throws. `templates/render.test.ts` snapshots every kind in
  both languages and proves the two catalogues reference the same variables — a
  translator dropping `{minutes}` would otherwise break exactly one language, at
  send time.

## Bounces and complaints

`POST /internal/mail/events` takes the SES feed over SNS. It is **not** behind
`InternalSignatureGuard`: SNS is AWS's publisher and will not compute our HMAC, so
the SNS message signature is the authentication instead — canonical string, RSA
verify, and a certificate fetched only from `https://sns.<region>.amazonaws.com/*.pem`
(the SSRF guard of 05 §8). Without that check, anyone who finds the path could
suppress any address they can name.

`MAIL_SNS_TOPIC_ARN` narrows it further when set. A signature proves a message
came from AWS, not that it came from _our_ topic — an account can publish a
validly-signed bounce for any address from a topic of its own — so with the
variable set, a message from any other `TopicArn` is refused before the
certificate is even fetched. Unset, any topic is accepted, which is the right
default: a deployment that has not configured it is better off receiving bounces
than silently discarding them.

SNS posts `Content-Type: text/plain`, which Nest's JSON parser skips, so
`SnsBodyMiddleware` is applied to that one route rather than widening the parser
for the whole API.

A permanent bounce or any complaint suppresses the address for ever; a transient
bounce for a fortnight, lifted early by a later `Delivery`. The live set is in Redis
keyed by SHA-256 of the address — a Redis dump should not be a mailing list — and
every change is also an `audit_log` row with the address masked, because "why did we
stop mailing this customer?" is asked months later and a cache is not an answer.

A `SubscriptionConfirmation` is verified and logged but **not** auto-confirmed:
confirming means an outbound GET to a URL that arrived in a request. An operator
confirms the topic once, from the console; the log line carries the ARN.

## The bell

`GET /me/notifications` and `POST /me/notifications/{id}/read`, scoped to the user
from the access token (a notification belongs to the person it is about, and someone
in three workspaces wants one list). Another user's id is a 404, not a 403.

Rows carry `(kind, data)` and no body text: the wording is rendered per locale at
read time, so switching to Hindi switches the bell too. `notification.created` goes
to the **workspace** room — those are the only rooms this server has — and carries
an id and a kind, never content; the client refetches.

`notification.created` is not in CONTRACTS §7, which names four events. It is
additive (a client that does not know it ignores the frame) and the amendment was
raised in the A25 report.
